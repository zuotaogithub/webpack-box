const fs = require('fs-extra')
const path = require('path')

const minimist = require('minimist')
const LRU = require('lru-cache')

const {
  chalk,
  execa,
  semver,
  hasProjectYarn,
  hasPnpmVersionOrLater,
  hasProjectPnpm,
  isOfficialPlugin,
  resolvePluginId,
  log,
  warn
} = require('@vue/cli-shared-utils')

const getPackageJson = require('./getPackageJson')
const { executeCommand } = require('./executeCommand')

const registries = require('./registries')

const metadataCache = new LRU({
  max: 200,
  maxAge: 1000 * 60 * 30 // 30 min.
})

const isTestOrDebug = process.env.VUE_CLI_TEST || process.env.VUE_CLI_DEBUG

const SUPPORTED_PACKAGE_MANAGERS = ['yarn', 'pnpm', 'npm']
const PACKAGE_MANAGER_PNPM4_CONFIG = {
  install: ['install', '--reporter', 'silent', '--shamefully-hoist'],
  add: ['install', '--reporter', 'silent', '--shamefully-hoist'],
  upgrade: ['update', '--reporter', 'silent'],
  remove: ['uninstall', '--reporter', 'silent']
}
const PACKAGE_MANAGER_PNPM3_CONFIG = {
  install: ['install', '--loglevel', 'error', '--shamefully-flatten'],
  add: ['install', '--loglevel', 'error', '--shamefully-flatten'],
  upgrade: ['update', '--loglevel', 'error'],
  remove: ['uninstall', '--loglevel', 'error']
}
const PACKAGE_MANAGER_CONFIG = {
  npm: {
    install: ['install', '--loglevel', 'error'],
    add: ['install', '--loglevel', 'error'],
    upgrade: ['update', '--loglevel', 'error'],
    remove: ['uninstall', '--loglevel', 'error']
  },
  pnpm: hasPnpmVersionOrLater('4.0.0') ? PACKAGE_MANAGER_PNPM4_CONFIG : PACKAGE_MANAGER_PNPM3_CONFIG,
  yarn: {
    install: [],
    add: ['add'],
    upgrade: ['upgrade'],
    remove: ['remove']
  }
}

function stripVersion (packageName) {
  const nameRegExp = /^(@?[^@]+)(@.*)?$/
  const result = packageName.match(nameRegExp)

  if (!result) {
    throw new Error(`Invalid package name ${packageName}`)
  }

  return result[1]
}

class PackageManager {
  constructor ({ context } = {}) {
    this.context = context

    this.bin = hasProjectYarn(context) ? 'yarn' : hasProjectPnpm(context) ? 'pnpm' : 'npm'

    if (!SUPPORTED_PACKAGE_MANAGERS.includes(this.bin)) {
      log()
      warn(
        `The package manager ${chalk.red(this.bin)} is ${chalk.red('not officially supported')}.\n` +
        `It will be treated like ${chalk.cyan('npm')}, but compatibility issues may occur.\n` +
        `See if you can use ${chalk.cyan('--registry')} instead.`
      )
      PACKAGE_MANAGER_CONFIG[this.bin] = PACKAGE_MANAGER_CONFIG.npm
    }
  }

  async getRegistry () {
    if (this._registry) {
      return this._registry
    }

    const args = minimist(process.argv, {
      alias: {
        r: 'registry'
      }
    })

    if (args.registry) {
      this._registry = args.registry
    } else {
      this._registry = registries.taobao
    }
  }

  async addRegistryToArgs (args) {
    const registry = await this.getRegistry()
    args.push(`--registry=${registry}`)

    return args
  }

  async setBinaryMirrors () {
    const registry = await this.getRegistry()
    if (registry !== registries.taobao) {
      return
    }
    try {
      const binaryMirrorConfig = await this.getMetadata('binary-mirror-config')
      const mirrors = binaryMirrorConfig.mirrors.china
      for (const key in mirrors.ENVS) {
        process.env[key] = mirrors.ENVS[key]
      }
      const cypressMirror = mirrors.cypress
      const defaultPlatforms = {
        darwin: 'osx64',
        linux: 'linux64',
        win32: 'win64'
      }
      const platforms = cypressMirror.newPlatforms || defaultPlatforms
      const targetPlatform = platforms[require('os').platform()]
      if (targetPlatform && !process.env.CYPRESS_INSTALL_BINARY) {
        const latestCypressVersion = await this.getRemoteVersion('cypress', '^3')
        process.env.CYPRESS_INSTALL_BINARY =
          `${cypressMirror.host}/${latestCypressVersion}/${targetPlatform}/cypress.zip`
      }
    } catch (e) {
      // get binary mirror config failed
    }
  }

  async getMetadata (packageName, { field = '' } = {}) {
    const registry = await this.getRegistry()

    const metadataKey = `${this.bin}-${registry}-${packageName}`
    let metadata = metadataCache.get(metadataKey)

    if (metadata) {
      return metadata
    }

    const args = await this.addRegistryToArgs(['info', packageName, field, '--json'])
    const { stdout } = await execa(this.bin, args)

    metadata = JSON.parse(stdout)
    if (this.bin === 'yarn') {
      // `yarn info` outputs messages in the form of `{"type": "inspect", data: {}}`
      metadata = metadata.data
    }

    metadataCache.set(metadataKey, metadata)
    return metadata
  }

  async getRemoteVersion (packageName, versionRange = 'latest') {
    const metadata = await this.getMetadata(packageName)
    if (Object.keys(metadata['dist-tags']).includes(versionRange)) {
      return metadata['dist-tags'][versionRange]
    }
    const versions = Array.isArray(metadata.versions) ? metadata.versions : Object.keys(metadata.versions)
    return semver.maxSatisfying(versions, versionRange)
  }

  getInstalledVersion (packageName) {
    // for first level deps, read package.json directly is way faster than `npm list`
    try {
      const packageJson = getPackageJson(
        path.resolve(this.context, 'node_modules', packageName)
      )
      return packageJson.version
    } catch (e) {
      return 'N/A'
    }
  }

  async install () {
    await this.setBinaryMirrors()
    const args = await this.addRegistryToArgs(PACKAGE_MANAGER_CONFIG[this.bin].install)
    return executeCommand(this.bin, args, this.context)
  }

  async add (packageName, isDev = true) {
    await this.setBinaryMirrors()
    const args = await this.addRegistryToArgs([
      ...PACKAGE_MANAGER_CONFIG[this.bin].add,
      packageName,
      ...(isDev ? ['-D'] : [])
    ])
    return executeCommand(this.bin, args, this.context)
  }

  async upgrade (packageName) {
    const realname = stripVersion(packageName)
    if (
      isTestOrDebug &&
      (packageName === '@vue/cli-service' || isOfficialPlugin(resolvePluginId(realname)))
    ) {
      // link packages in current repo for test
      const src = path.resolve(__dirname, `../../../../${realname}`)
      const dest = path.join(this.context, 'node_modules', realname)
      await fs.remove(dest)
      await fs.symlink(src, dest, 'dir')
      return
    }

    await this.setBinaryMirrors()
    const args = await this.addRegistryToArgs([
      ...PACKAGE_MANAGER_CONFIG[this.bin].add,
      packageName
    ])
    return executeCommand(this.bin, args, this.context)
  }

  async remove (packageName) {
    const args = [
      ...PACKAGE_MANAGER_CONFIG[this.bin].remove,
      packageName
    ]
    return executeCommand(this.bin, args, this.context)
  }
}

module.exports = PackageManager
