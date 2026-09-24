const path = require('node:path')
const { container: { ModuleFederationPlugin } } = require('webpack')

module.exports = {
  mode: 'production',
  entry: {},
  experiments: { outputModule: true },
  output: {
    path: path.resolve(__dirname, 'public'),
    publicPath: 'auto',
    module: true,
    chunkFilename: '[name].mjs',
    clean: { keep: /^(index\.html|webapp\.js|webapp\.css)$/ }
  },
  module: {
    rules: [{
      test: /\.jsx$/,
      exclude: /node_modules/,
      use: { loader: 'babel-loader', options: { presets: ['@babel/preset-react'] } }
    }]
  },
  resolve: { extensions: ['.js', '.jsx'] },
  plugins: [new ModuleFederationPlugin({
    name: 'signalk_victoriametrics_history_provider',
    library: { type: 'module' },
    filename: 'remoteEntry.js',
    exposes: { './PluginConfigurationPanel': './src/configpanel/PluginConfigurationPanel.jsx' },
    shared: {
      react: { singleton: true, requiredVersion: '^19' },
      'react-dom': { singleton: true, requiredVersion: '^19' }
    }
  })]
}
