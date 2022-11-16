package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"

	"github.com/wundergraph/wundergraph/pkg/files"
	"github.com/wundergraph/wundergraph/pkg/node"
	"github.com/wundergraph/wundergraph/pkg/wgpb"
)

var nodeCmd = &cobra.Command{
	Use:   "node",
	Short: "Subcommand to work with WunderGraph node",
}

var nodeStartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start runs WunderGraph Node in production mode",
	Long: `
		Example usage:
			wunderctl node start
`,
	Run: func(cmd *cobra.Command, args []string) {
		sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()

		g, ctx := errgroup.WithContext(sigCtx)

		n, err := NewWunderGraphNode(ctx)
		if err != nil {
			log.Fatal("Could not create node: %w", zap.Error(err))
		}

		g.Go(func() error {
			return StartWunderGraphNode(n, WithIdleHandler(stop))
		})

		n.HandleGracefulShutdown(gracefulTimeout)

		// Only exit with error code 1 when the server was not stopped by the signal
		if err := g.Wait(); sigCtx.Err() == nil && err != nil {
			// Exit with error code 1 to indicate failure and restart
			log.Fatal("WunderGraph process shutdown: %w", zap.Error(err))
		}

		// exit code 0 to indicate success
	},
}

var nodeUrlCmd = &cobra.Command{
	Use:   "url",
	Short: "url prints the WunderGraph node URL",
	Run: func(cmd *cobra.Command, args []string) {
		ctx := context.Background()
		n, err := NewWunderGraphNode(ctx)
		if err != nil {
			log.Fatal("Could not create node: %w", zap.Error(err))
		}
		config, err := CreateWunderGraphNodeConfiguration(n)
		if err != nil {
			if err != nil {
				log.Fatal("Could not create node configuration: %w", zap.Error(err))
			}
		}
		fmt.Println(config.Api.Options.PublicNodeUrl)
	},
}

func init() {
	nodeCmd.AddCommand(nodeStartCmd)
	nodeCmd.AddCommand(nodeUrlCmd)
	rootCmd.AddCommand(nodeCmd)

	nodeStartCmd.Flags().IntVar(&shutdownAfterIdle, "shutdown-after-idle", 0, "shuts down the server after given seconds in idle when no requests have been served")
}

func NewWunderGraphNode(ctx context.Context) (*node.Node, error) {
	wunderGraphDir, err := files.FindWunderGraphDir(_wunderGraphDirConfig)
	if err != nil {
		return nil, err
	}

	return node.New(ctx, BuildInfo, wunderGraphDir, log), nil
}

type options struct {
	hooksServerHealthCheck bool
	idleHandler            func()
	prettyLogging          bool
}

type Option func(options *options)

func WithHooksServerHealthCheck() Option {
	return func(options *options) {
		options.hooksServerHealthCheck = true
	}
}

func WithIdleHandler(idleHandler func()) Option {
	return func(options *options) {
		options.idleHandler = idleHandler
	}
}

func CreateWunderGraphNodeConfiguration(n *node.Node) (*node.WunderNodeConfig, error) {
	configFile := path.Join(n.WundergraphDir, "generated", configJsonFilename)
	if !files.FileExists(configFile) {
		return nil, fmt.Errorf("could not find configuration file: %s", configFile)
	}

	data, err := os.ReadFile(configFile)
	if err != nil {
		log.Error("Failed to read file", zap.String("filePath", configFile), zap.Error(err))
		return nil, err
	}

	if len(data) == 0 {
		log.Error("Config file is empty", zap.String("filePath", configFile))
		return nil, errors.New("config file is empty")
	}

	var graphConfig wgpb.WunderGraphConfiguration
	err = json.Unmarshal(data, &graphConfig)
	if err != nil {
		log.Error("Failed to unmarshal", zap.String("filePath", configFile), zap.Error(err))
		return nil, errors.New("failed to unmarshal config file")
	}

	wunderNodeConfig, err := node.CreateConfig(&graphConfig)
	if err != nil {
		log.Error("Failed to create config", zap.String("filePath", configFile), zap.Error(err))
		return nil, err
	}
	return wunderNodeConfig, nil
}

func StartWunderGraphNode(n *node.Node, opts ...Option) error {
	var options options
	for i := range opts {
		opts[i](&options)
	}

	config, err := CreateWunderGraphNodeConfiguration(n)
	if err != nil {
		return err
	}

	nodeOpts := []node.Option{
		node.WithStaticWunderNodeConfig(config),
		node.WithDebugMode(rootFlags.DebugMode),
		node.WithForceHttpsRedirects(!disableForceHttpsRedirects),
		node.WithIntrospection(enableIntrospection),
		node.WithPrettyLogging(rootFlags.PrettyLogs),
	}

	if shutdownAfterIdle > 0 {
		nodeOpts = append(nodeOpts, node.WithIdleTimeout(time.Duration(shutdownAfterIdle)*time.Second, func() {
			log.Info("shutting down due to idle timeout")
			options.idleHandler()
		}))
	}

	if options.hooksServerHealthCheck {
		nodeOpts = append(nodeOpts, node.WithHooksServerHealthCheck(time.Duration(healthCheckTimeout)*time.Second))
	}

	err = n.StartBlocking(nodeOpts...)
	if err != nil {
		return err
	}

	return nil
}
