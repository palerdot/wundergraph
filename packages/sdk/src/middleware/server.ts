import { WunderGraphConfiguration } from '@wundergraph/protobuf';
import FastifyGraceful from 'fastify-graceful-shutdown';
import { Headers } from 'headers-polyfill';
import process from 'node:process';
import HooksPlugin, { HooksRouteConfig } from './plugins/hooks';
import FastifyWebhooksPlugin, { WebHookRouteConfig } from './plugins/webhooks';
import GraphQLServerPlugin, { GraphQLServerConfig } from './plugins/graphql';
import Fastify, { FastifyInstance, FastifyLoggerInstance } from 'fastify';
import { HooksConfiguration } from '../configure';
import type { InternalClient } from './internal-client';
import { InternalClientFactory, internalClientFactory } from './internal-client';
import path from 'path';
import fs from 'fs';
import { middlewarePort } from '../env';

declare module 'fastify' {
	interface FastifyRequest extends FastifyRequestContext {}
}

export interface FastifyRequestContext<User = any, IC = InternalClient> {
	ctx: BaseContext<User, IC>;
}

export interface BaseContext<User = any, IC = InternalClient> {
	/**
	 * The user that is currently logged in.
	 */
	user?: User;
	clientRequest: ClientRequest;
	/**
	 * The request logger.
	 */
	log: FastifyLoggerInstance;
	/**
	 * The internal client that is used to communicate with the server.
	 */
	internalClient: IC;
}

export interface ClientRequestHeaders extends Headers {}

export interface ClientRequest<H = ClientRequestHeaders> {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'CONNECT' | 'TRACE';
	requestURI: string;
	/**
	 * Contains all client request headers. You can manipulate the map to add or remove headers.
	 * This might impact upstream hooks. Global hooks don't take changes into account.
	 */
	headers: H;
}

export interface WunderGraphRequest {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'CONNECT' | 'TRACE';
	requestURI: string;
	headers: Headers;
	body: any;
}

export interface WunderGraphResponse extends WunderGraphRequest {
	status: string;
	statusCode: number;
}

export type JSONValue = string | number | boolean | JSONObject | Array<JSONValue>;

export type JSONObject = { [key: string]: JSONValue };

export interface WunderGraphUser<Role = any> {
	provider?: string;
	providerId?: string;
	email?: string;
	emailVerified?: boolean;
	name?: string;
	firstName?: string;
	lastName?: string;
	nickName?: string;
	description?: string;
	userId?: string;
	avatarUrl?: string;
	location?: string;
	roles?: Role[];
	customAttributes?: string[];
	customClaims?: {
		[key: string]: any;
	};
	accessToken?: JSONObject;
	rawAccessToken?: string;
	idToken?: JSONObject;
	rawIdToken?: string;
}

export interface WunderGraphServerConfig<GeneratedHooksConfig = HooksConfiguration> {
	hooks: GeneratedHooksConfig;
	graphqlServers?: Omit<GraphQLServerConfig, 'routeUrl'>[];
}

export interface WunderGraphHooksAndServerConfig<GeneratedHooksConfig = HooksConfiguration>
	extends WunderGraphServerConfig<GeneratedHooksConfig> {
	graphqlServers?: (GraphQLServerConfig & { url: string })[];
}

export const SERVER_PORT = middlewarePort;

process.on('uncaughtExceptionMonitor', (err, origin) => {
	console.error(`uncaught exception, origin: ${origin}, error: ${err}`);
});

let WG_CONFIG: WunderGraphConfiguration;
let clientFactory: InternalClientFactory;

if (process.env.START_HOOKS_SERVER === 'true') {
	if (!process.env.WG_ABS_DIR) {
		console.error('The environment variable `WG_ABS_DIR` is required!');
		process.exit(1);
	}
	try {
		const configContent = fs.readFileSync(path.join(process.env.WG_ABS_DIR, 'generated', 'wundergraph.config.json'), {
			encoding: 'utf8',
		});
		try {
			WG_CONFIG = JSON.parse(configContent);
			if (WG_CONFIG.api) {
				clientFactory = internalClientFactory(WG_CONFIG.apiName, WG_CONFIG.deploymentName, WG_CONFIG.api.operations);
			} else {
				console.error('Could not get user defined api. Try `wunderctl generate`');
				process.exit(1);
			}
		} catch (err: any) {
			console.error('Could not parse wundergraph.config.json. Try `wunderctl generate`');
			process.exit(1);
		}
	} catch {
		console.error('Could not load wundergraph.config.json. Did you forget to run `wunderctl generate` ?');
		process.exit(1);
	}
}

export const configureWunderGraphServer = <
	GeneratedHooksConfig extends HooksConfiguration,
	GeneratedClient extends InternalClient
>(
	configWrapper: () => WunderGraphServerConfig<GeneratedHooksConfig>
): WunderGraphHooksAndServerConfig => {
	return _configureWunderGraphServer(configWrapper());
};

const _configureWunderGraphServer = <GeneratedHooksConfig extends HooksConfiguration>(
	config: WunderGraphServerConfig<GeneratedHooksConfig>
): WunderGraphHooksAndServerConfig => {
	const hooksConfig = config as WunderGraphHooksAndServerConfig;

	/**
	 * Configure the custom GraphQL servers
	 */
	if (hooksConfig.graphqlServers) {
		let seenServer: { [key: string]: boolean } = {};
		hooksConfig.graphqlServers.forEach((server) => {
			if (seenServer[server.serverName]) {
				throw new Error(`A server with the name '${server.serverName}' has been already registered!`);
			}
			seenServer[server.serverName] = true;
		});
		for (const server of hooksConfig.graphqlServers) {
			server.url = `http://127.0.0.1:${SERVER_PORT}/gqls/${server.serverName}/graphql`;
		}
	}

	/**
	 * This environment variable is used to determine if the server should start the hooks server.
	 */
	if (process.env.START_HOOKS_SERVER === 'true') {
		const fastify = Fastify({
			logger: {
				level: process.env.LOG_LEVEL || 'info',
			},
		});
		startServer(fastify, hooksConfig, WG_CONFIG).catch((err) => {
			fastify.log.error(err, 'Could not start the hook server');
			process.exit(1);
		});
	}

	return hooksConfig;
};

export const startServer = async (
	fastify: FastifyInstance,
	hooksConfig: WunderGraphHooksAndServerConfig,
	config: WunderGraphConfiguration
) => {
	fastify.decorateRequest('ctx', null);

	/**
	 * Calls per event registration. We use it for debugging only.
	 */
	fastify.addHook('onRoute', (routeOptions) => {
		const routeConfig = routeOptions.config as HooksRouteConfig | WebHookRouteConfig | undefined;
		if (routeConfig?.kind === 'hook') {
			if (routeConfig.operationName) {
				fastify.log.debug(
					`Registered Operation Hook '${routeConfig.operationName}' with (${routeOptions.method}) '${routeOptions.url}'`
				);
			} else {
				fastify.log.debug(`Registered Global Hook (${routeOptions.method}) '${routeOptions.url}'`);
			}
		} else if (routeConfig?.kind === 'webhook') {
			fastify.log.debug(
				`Registered Webhook '${routeConfig.webhookName}' with (${routeOptions.method}) '${routeOptions.url}'`
			);
		}
	});

	await fastify.register(HooksPlugin, { ...hooksConfig.hooks, config, internalClientFactory: clientFactory });
	fastify.log.info('Hooks plugin registered');

	if (config.api) {
		await fastify.register(FastifyWebhooksPlugin, { webhooks: config.api.webhooks });
		fastify.log.info('Webhooks plugin registered');
	}

	if (hooksConfig.graphqlServers) {
		for await (const server of hooksConfig.graphqlServers) {
			const routeUrl = `/gqls/${server.serverName}/graphql`;
			await fastify.register(GraphQLServerPlugin, { ...server, routeUrl: routeUrl });
			fastify.log.info('GraphQL plugin registered');
			fastify.log.info(`Graphql server '${server.serverName}' listening at ${server.url}`);
		}
	}

	// only in production because it slows down watch process in development
	if (process.env.NODE_ENV === 'production') {
		await fastify.register(FastifyGraceful);
		fastify.gracefulShutdown((signal, next) => {
			fastify.log.info('graceful shutdown', { signal });
			next();
		});
	}

	return fastify.listen({
		port: SERVER_PORT,
		host: '127.0.0.1',
	});
};
