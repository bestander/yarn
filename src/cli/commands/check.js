/* @flow */

import type {Reporter} from '../../reporters/index.js';
import type Config from '../../config.js';
import {MessageError} from '../../errors.js';
import {Install} from './install.js';
import Lockfile from '../../lockfile/wrapper.js';
import * as fs from '../../util/fs.js';

const semver = require('semver');
const path = require('path');

export const requireLockfile = true;
export const noArguments = true;

export function setFlags(commander: Object) {
  commander.option('--integrity');
  commander.option('--commonjs');
}

async function commonJsCheck(
  config: Config,
  reporter: Reporter,
  flags: Object,
  args: Array<string>,
): Promise<void> {
  let errCount = 0;
  function reportError(msg, ...vars) {
    reporter.error(reporter.lang(msg, ...vars));
    errCount++;
  }
  // check all dependencies recursively without relying on internal resolver
  const registryName = 'yarn';
  const registry = config.registries[registryName];
  const rootManifest = await config.readManifest(registry.cwd, registryName);

  type PackageToVerify = {
    name: string,
    originalKey: string,
    parentCwd: string,
    version: string,
  };
  const dependenciesToCheckVersion: PackageToVerify[] = [];
  if (rootManifest.dependencies) {
    for (const name in rootManifest.dependencies) {
      dependenciesToCheckVersion.push({
        name,
        originalKey: name,
        parentCwd: registry.cwd,
        version: rootManifest.dependencies[name],
      });
    }
  }
  if (rootManifest.devDependencies && !config.production) {
    for (const name in rootManifest.devDependencies) {
      dependenciesToCheckVersion.push({
        name,
        originalKey: name,
        parentCwd: registry.cwd,
        version: rootManifest.devDependencies[name],
      });
    }
  }

  const locationsVisited: Set<string> = new Set();
  while (dependenciesToCheckVersion.length) {
    const dep = dependenciesToCheckVersion.shift();
    const manifestLoc = path.join(dep.parentCwd, registry.folder, dep.name);
    if (locationsVisited.has(manifestLoc + `@${dep.version}`)) {
      continue;
    }
    locationsVisited.add(manifestLoc + `@${dep.version}`);
    if (!await fs.exists(manifestLoc)) {
      reportError('packageNotInstalled', `${dep.originalKey}`);
      continue;
    }
    const pkg = await config.readManifest(manifestLoc, registryName);
    if (
      semver.validRange(dep.version, config.looseSemver) &&
      !semver.satisfies(pkg.version, dep.version, config.looseSemver)
      ) {
      reportError('packageWrongVersion', dep.originalKey, dep.version, pkg.version);
      continue;
    }
    const dependencies = pkg.dependencies;
    if (dependencies) {
      for (const subdep in dependencies) {
        const subDepPath = path.join(manifestLoc, registry.folder, subdep);
        let found = false;
        const relative = path.relative(registry.cwd, subDepPath);
        const locations = path.normalize(relative).split(registry.folder + path.sep).
          filter((dir) => !!dir);
        locations.pop();
        while (locations.length >= 0) {
          let possiblePath;
          if (locations.length > 0) {
            possiblePath = path.join(registry.cwd, registry.folder,
              locations.join(path.sep + registry.folder + path.sep));
          } else {
            possiblePath = registry.cwd;
          }
          if (await fs.exists(path.join(possiblePath, registry.folder, subdep))) {
            dependenciesToCheckVersion.push({
              name: subdep,
              originalKey: `${dep.originalKey}#${subdep}`,
              parentCwd: possiblePath,
              version: dependencies[subdep],
            });
            found = true;
            break;
          }
          if (!locations.length) {
            break;
          }
          locations.pop();
        }
        if (!found) {
          reportError('packageNotInstalled', `${dep.originalKey}#${subdep}`);
        }
      }
    }
  }

  if (errCount > 0) {
    throw new MessageError(reporter.lang('foundErrors', errCount));
  } else {
    reporter.success(reporter.lang('folderInSync'));
  }
}

async function integrityHashCheck(
  config: Config,
  reporter: Reporter,
  flags: Object,
  args: Array<string>,
): Promise<void> {
  let errCount = 0;
  function reportError(msg, ...vars) {
    reporter.error(reporter.lang(msg, ...vars));
    errCount++;
  }

  const lockfile = await Lockfile.fromDirectory(config.cwd);
  const install = new Install(flags, config, reporter, lockfile);

  // get patterns that are installed when running `yarn install`
  const {patterns: rawPatterns} = await install.hydrate(true);
  const patterns = await install.flatten(rawPatterns);

  // check if patterns exist in lockfile
  for (const pattern of patterns) {
    if (!lockfile.getLocked(pattern)) {
      reportError('lockfileNotContainPatter', pattern);
    }
  }

  const integrityLoc = await install.getIntegrityHashLocation();
  if (integrityLoc && await fs.exists(integrityLoc)) {
    const match = await install.matchesIntegrityHash(patterns);
    if (match.matches === false) {
      reportError('integrityHashesDontMatch', match.expected, match.actual);
    }
  } else {
    reportError('noIntegirtyHashFile');
  }

  if (errCount > 0) {
    throw new MessageError(reporter.lang('foundErrors', errCount));
  } else {
    reporter.success(reporter.lang('folderInSync'));
  }
}

export async function run(
  config: Config,
  reporter: Reporter,
  flags: Object,
  args: Array<string>,
): Promise<void> {
  if (flags.commonjs) {
    await commonJsCheck(config, reporter, flags, args);
    return;
  } else if (flags.integrity) {
    await integrityHashCheck(config, reporter, flags, args);
    return;
  }

  const lockfile = await Lockfile.fromDirectory(config.cwd);
  const install = new Install(flags, config, reporter, lockfile);

  function humaniseLocation(loc: string): Array<string> {
    const relative = path.relative(path.join(config.cwd, 'node_modules'), loc);
    const normalized = path.normalize(relative).split(path.sep);
    return normalized.filter((p) => p !== 'node_modules').reduce((result, part) => {
      const length = result.length;
      if (length && result[length - 1].startsWith('@') && !result[length - 1].includes(path.sep)) {
        result[length - 1] += path.sep + part;
      } else {
        result.push(part);
      }
      return result;
    }, []);
  }

  let warningCount = 0;
  let errCount = 0;
  function reportError(msg, ...vars) {
    reporter.error(reporter.lang(msg, ...vars));
    errCount++;
  }

  // get patterns that are installed when running `yarn install`
  const {patterns: rawPatterns} = await install.hydrate(true);
  const patterns = await install.flatten(rawPatterns);

  // check if patterns exist in lockfile
  for (const pattern of patterns) {
    if (!lockfile.getLocked(pattern)) {
      reportError('lockfileNotContainPatter', pattern);
    }
  }

  // check if any of the node_modules are out of sync
  const res = await install.linker.getFlatHoistedTree(patterns);
  for (const [loc, {originalKey, pkg, ignore}] of res) {
    if (ignore) {
      continue;
    }

    const parts = humaniseLocation(loc);

    // grey out hoisted portions of key
    let human = originalKey;
    const hoistedParts = parts.slice();
    const hoistedKey = parts.join('#');
    if (human !== hoistedKey) {
      const humanParts = human.split('#');

      for (let i = 0; i < humanParts.length; i++) {
        const humanPart = humanParts[i];

        if (hoistedParts[0] === humanPart) {
          hoistedParts.shift();

          if (i < humanParts.length - 1) {
            humanParts[i] += '#';
          }
        } else {
          humanParts[i] = reporter.format.dim(`${humanPart}#`);
        }
      }

      human = humanParts.join('');
    }

    const pkgLoc = path.join(loc, 'package.json');
    if (!(await fs.exists(loc)) || !(await fs.exists(pkgLoc))) {
      if (pkg._reference.optional) {
        reporter.warn(reporter.lang('optionalDepNotInstalled', human));
      } else {
        reportError('packageNotInstalled', human);
      }
      continue;
    }

    const packageJson = await config.readJson(pkgLoc);
    if (pkg.version !== packageJson.version) {
      // node_modules contains wrong version
      reportError('packageWrongVersion', human, pkg.version, packageJson.version);
    }

    const deps = Object.assign({}, packageJson.dependencies, packageJson.peerDependencies);

    for (const name in deps) {
      const range = deps[name];
      if (!semver.validRange(range, config.looseSemver)) {
        continue; // exotic
      }

      const subHuman = `${human}#${name}@${range}`;

      // find the package that this will resolve to, factoring in hoisting
      const possibles = [];
      let depPkgLoc;
      for (let i = parts.length; i >= 0; i--) {
        const myParts = parts.slice(0, i).concat(name);

        // build package.json location for this position
        const myDepPkgLoc = path.join(
          config.cwd,
          'node_modules',
          myParts.join(`${path.sep}node_modules${path.sep}`),
          'package.json',
        );

        possibles.push(myDepPkgLoc);
      }
      while (possibles.length) {
        const myDepPkgLoc = possibles.shift();
        if (await fs.exists(myDepPkgLoc)) {
          depPkgLoc = myDepPkgLoc;
          break;
        }
      }
      if (!depPkgLoc) {
        // we'll hit the module not install error above when this module is hit
        continue;
      }

      //
      const depPkg = await config.readJson(depPkgLoc);
      const foundHuman = `${humaniseLocation(path.dirname(depPkgLoc)).join('#')}@${depPkg.version}`;
      if (!semver.satisfies(depPkg.version, range, config.looseSemver)) {
        // module isn't correct semver
        reportError('packageDontSatisfy', subHuman, foundHuman);
        continue;
      }

      // check for modules above us that this could be deduped to
      for (const loc of possibles) {
        if (!await fs.exists(loc)) {
          continue;
        }

        const packageJson = await config.readJson(loc);
        if (packageJson.version === depPkg.version ||
           (semver.satisfies(packageJson.version, range, config.looseSemver) &&
           semver.gt(packageJson.version, depPkg.version, config.looseSemver))) {
          reporter.warn(
            reporter.lang(
              'couldBeDeduped',
              subHuman,
              packageJson.version,
              `${humaniseLocation(path.dirname(loc)).join('#')}@${packageJson.version}`,
            ),
          );
          warningCount++;
        }
        break;
      }
    }
  }

  if (warningCount > 1) {
    reporter.info(reporter.lang('foundWarnings', warningCount));
  }

  if (errCount > 0) {
    throw new MessageError(reporter.lang('foundErrors', errCount));
  } else {
    reporter.success(reporter.lang('folderInSync'));
  }
}
