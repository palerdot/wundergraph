import chalk from 'chalk';
import { createWriteStream, promises as fsp } from 'fs';
import got from 'got';
import ora from 'ora';
import { tmpdir } from 'os';
import { join } from 'path';
import { Stream } from 'stream';
import tar from 'tar';
import { promisify } from 'util';

const pipeline = promisify(Stream.pipeline);

export const downloadTar = async (url: string) => {
	try {
		const tempFile = join(tmpdir(), `wundergraph-example.temp-${Date.now()}`);
		await pipeline(got.stream(url), createWriteStream(tempFile));
		return tempFile;
	} catch (e) {
		console.error('Error', e);
		return '';
	}
};

export const downloadAndExtractRepo = async ({
	root,
	repoName,
	branch,
	repoOwnerName,
	filePath,
}: {
	root: string;
	repoName: string;
	branch: string;
	repoOwnerName: string;
	filePath?: string;
}) => {
	try {
		const spinner = ora('Loading..').start();
		const tempFile = await downloadTar(`https://codeload.github.com/${repoOwnerName}/${repoName}/tar.gz/${branch}`);
		await tar.x({
			file: tempFile,
			cwd: root,
			strip: filePath ? filePath.split('/').length + 1 : 1,
			filter: (p) => p.startsWith(`${repoName}-${branch}${filePath ? `/${filePath}` : ''}`),
		});
		await fsp.unlink(tempFile);
		spinner.succeed(chalk.green('Successfully cloned the repository'));
	} catch (e) {
		console.error(chalk.red('Failed to clone the repository'));
		process.exit(1);
	}
};
