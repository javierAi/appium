// @ts-check
import B from 'bluebird';
import { promises as fs } from 'fs';
import { DRIVER_TYPE, PLUGIN_TYPE } from '../../../lib/constants';
import { resolveFixture, rewiremock } from '../../helpers';
import { initMocks } from './mocks';

const {expect} = chai;

describe('Manifest', function () {
  /**
   * @type {sinon.SinonSandbox}
   */
  let sandbox;

  /** @type {string} */
  let yamlFixture;

  /** @type {import('./mocks').MockPackageChanged} */
  let MockPackageChanged;

  /** @type {import('./mocks').MockAppiumSupport} */
  let MockAppiumSupport;

  before(async function () {
    yamlFixture = await fs.readFile(resolveFixture('extensions.yaml'), 'utf8');
  });

  /**
   * @type {typeof import('../../../lib/extension/manifest').Manifest}
   */
  let Manifest;

  beforeEach(function () {
    let overrides;
    ({MockPackageChanged, MockAppiumSupport, overrides, sandbox} = initMocks());
    MockAppiumSupport.fs.readFile.resolves(yamlFixture);

    ({Manifest} = rewiremock.proxy(
      () => require('../../../lib/extension/manifest'),
      overrides,
    ));

    Manifest.getInstance.cache = new Map();
  });

  afterEach(function () {
    sandbox.restore();
  });

  describe('class method', function () {
    describe('getInstance()', function () {
      describe('when called twice with the same `appiumHome` value', function () {
        it('should return the same object both times', function () {
          const firstInstance = Manifest.getInstance('/some/path');
          const secondInstance = Manifest.getInstance('/some/path');
          expect(firstInstance).to.equal(secondInstance);
        });
      });

      describe('when called twice with different `appiumHome` values', function () {
        it('should return different objects', function () {
          const firstInstance = Manifest.getInstance('/some/path');
          const secondInstance = Manifest.getInstance('/some/other/path');
          expect(firstInstance).to.not.equal(secondInstance);
        });
      });
    });
  });

  describe('property', function () {
    describe('appiumHome', function () {
      it('should return the `appiumHome` path', function () {
        expect(Manifest.getInstance('/some/path').appiumHome).to.equal(
          '/some/path',
        );
      });

      it('should not be writable', function () {
        const instance = Manifest.getInstance('/some/path');
        expect(() => {
          // @ts-expect-error
          instance.appiumHome = '/some/other/path';
        }).to.throw(TypeError);
      });
    });

    describe('manifestPath', function () {
      describe('before `read()` has been called', function () {
        it('should be undefined', function () {
          expect(Manifest.getInstance('/some/path').manifestPath).to.be
            .undefined;
        });
      });

      describe('after `read()` has been called', function () {
        let manifest;
        beforeEach(async function () {
          manifest = Manifest.getInstance('/some/path');
          await manifest.read();
        });

        it('should return the manifest file path', function () {
          // this path is not the actual path; it's mocked in `MockAppiumSupport.env.resolveManifestPath`.
          expect(Manifest.getInstance('/some/path').manifestPath).to.equal(
            '/some/path/extensions.yaml',
          );
        });
      });

      it('should not be writable', function () {
        const instance = Manifest.getInstance('/some/path');
        expect(() => {
          // @ts-expect-error
          instance.manifestPath = '/some/other/path';
        }).to.throw(TypeError);
      });
    });
  });

  describe('instance method', function () {
    /** @type {import('../../../lib/extension/manifest').Manifest} */
    let manifest;

    beforeEach(function () {
      Manifest.getInstance.cache = new Map();
      manifest = Manifest.getInstance('/some/path');
    });

    describe('read()', function () {
      beforeEach(function () {
        sandbox.stub(manifest, 'syncWithInstalledExtensions').resolves();
      });

      describe('when the file does not yet exist', function () {
        beforeEach(async function () {
          /** @type {NodeJS.ErrnoException} */
          const err = new Error();
          err.code = 'ENOENT';
          MockAppiumSupport.fs.readFile.rejects(err);
          await manifest.read();
        });

        it('should create a new file', function () {
          expect(MockAppiumSupport.fs.writeFile).to.be.calledOnce;
        });
      });

      describe('when the file is invalid YAML', function () {
        beforeEach(function () {
          MockAppiumSupport.fs.readFile.resolves('{');
        });
        it('should reject', async function () {
          await expect(manifest.read()).to.be.rejectedWith(
            Error,
            /trouble loading the extension installation cache file/i,
          );
        });
      });

      describe('when the manifest path cannot be determined', function () {
        beforeEach(function () {
          MockAppiumSupport.env.resolveManifestPath.rejects(
            new Error('Could not determine manifest path'),
          );
        });

        it('should reject', async function () {
          await expect(manifest.read()).to.be.rejectedWith(
            Error,
            /could not determine manifest path/i,
          );
        });
      });

      describe('when called again before the first call resolves', function () {
        beforeEach(async function () {
          await B.all([manifest.read(), manifest.read()]);
        });
        it('should not read the file twice', function () {
          expect(MockAppiumSupport.fs.readFile).to.have.been.calledOnceWith(
            '/some/path/extensions.yaml',
            'utf8',
          );
        });
      });

      describe('when the file already exists', function () {
        beforeEach(async function () {
          sandbox.spy(manifest, 'write');
          await manifest.read();
        });

        it('should attempt to read the file at `filepath`', function () {
          expect(MockAppiumSupport.fs.readFile).to.have.been.calledOnceWith(
            '/some/path/extensions.yaml',
            'utf8',
          );
        });

        describe('when the data has not changed', function () {
          it('should not write the data', function () {
            expect(manifest.write).not.to.be.called;
          });
        });

        describe('when a local `appium` is installed', function () {
          beforeEach(function () {
            MockAppiumSupport.env.hasAppiumDependency.resolves(true);
            MockPackageChanged.isPackageChanged.resolves({
              isChanged: true,
              writeHash: sandbox.stub(),
              hash: 'foasdif',
              oldHash: 'sdjifh',
            });
          });

          it('should synchronize manifest with installed extensions', async function () {
            await manifest.read();
            expect(manifest.syncWithInstalledExtensions).to.be.calledOnce;
          });

          it('should check if the `package.json` has changed', async function () {
            await manifest.read();
            expect(MockPackageChanged.isPackageChanged).to.be.calledOnce;
          });
        });
      });
    });

    describe('write()', function () {
      beforeEach(function () {
        sandbox.stub(manifest, 'syncWithInstalledExtensions').resolves();
      });

      describe('when called after `read()`', function () {
        /** @type {import('../../../lib/extension/manifest').ManifestData} */
        let data;

        /** @type {ExtData<DriverType>} */
        const extData = {
          version: '1.0.0',
          automationName: 'Derp',
          mainClass: 'SomeClass',
          pkgName: 'derp',
          platformNames: ['dogs', 'cats'],
          installSpec: 'derp',
          installType: 'npm',
        };

        beforeEach(async function () {
          data = await manifest.read();
        });

        describe('when called again before the first call resolves', function () {
          it('should not write the file twice', async function () {
            await B.all([manifest.write(), manifest.write()]);
            expect(MockAppiumSupport.fs.writeFile).to.have.been.calledOnce;
          });
        });

        describe('when the manifest file was successfully written to', function () {
          it('should return `true`', async function () {
            expect(await manifest.write()).to.be.true;
          });
        });

        describe('when the manifest file could not be written', function () {
          beforeEach(function () {
            MockAppiumSupport.fs.writeFile.rejects();
            data.drivers.foo = extData;
          });

          it('should reject', async function () {
            await expect(manifest.write()).to.be.rejectedWith(
              Error,
              /Appium could not write to manifest/i,
            );
          });
        });

        describe('when the manifest directory could not be created', function () {
          beforeEach(function () {
            MockAppiumSupport.fs.mkdirp.rejects();
          });

          it('should reject', async function () {
            await expect(manifest.write()).to.be.rejectedWith(
              Error,
              /could not create the directory for the manifest file/i,
            );
          });
        });
      });
    });

    describe('addExtension()', function () {
      /** @type {ExtData<DriverType>} */
      const extData = {
        automationName: 'derp',
        version: '1.0.0',
        mainClass: 'SomeClass',
        pkgName: 'derp',
        platformNames: ['dogs', 'cats'],
        installSpec: 'derp',
        installType: 'npm',
      };

      it('should add the extension to the internal data object', function () {
        manifest.addExtension('driver', 'foo', extData);
        expect(manifest.getExtensionData('driver').foo).to.equal(extData);
      });

      describe('when existing extension added', function () {
        /** @type {ExtData<DriverType>} */

        beforeEach(function () {
          manifest.addExtension('driver', 'foo', extData);
        });

        it('should rewrite', function () {
          const expected = {
            ...extData,
            automationName: 'BLAAHAH',
          };
          manifest.addExtension('driver', 'foo', expected);
          expect(manifest.getExtensionData('driver').foo).to.equal(expected);
        });
      });
    });

    describe('addExtensionFromPackage()', function () {
      describe('when provided a valid package.json for a driver and its path', function () {
        /** @type {ExtensionPackageJson<DriverType>} */
        let packageJson;

        beforeEach(function () {
          packageJson = {
            name: 'derp',
            version: '1.0.0',
            appium: {
              automationName: 'derp',
              mainClass: 'SomeClass',
              platformNames: ['dogs', 'cats'],
              driverName: 'myDriver',
            },
          };
        });

        it('should add an extension to the internal data', function () {
          manifest.addExtensionFromPackage(
            packageJson,
            '/some/path/to/package.json',
          );
          expect(manifest.getExtensionData('driver')).to.deep.equal({
            myDriver: {
              automationName: 'derp',
              mainClass: 'SomeClass',
              pkgName: 'derp',
              platformNames: ['dogs', 'cats'],
              version: '1.0.0',
              installType: 'npm',
              installSpec: 'derp@1.0.0',
            },
          });
        });

        it('should return `true`', function () {
          expect(
            manifest.addExtensionFromPackage(
              packageJson,
              '/some/path/to/package.json',
            ),
          ).to.be.true;
        });

        describe('when the driver has already been registered', function () {
          beforeEach(function () {
            manifest.addExtensionFromPackage(
              packageJson,
              '/some/path/to/package.json',
            );
          });

          it('should return `false`', function () {
            expect(
              manifest.addExtensionFromPackage(
                packageJson,
                '/some/path/to/package.json',
              ),
            ).to.be.false;
          });
        });
      });

      describe('when provided a valid package.json for a plugin and its path', function () {
        /** @type {ExtensionPackageJson<PluginType>} */
        let packageJson;
        beforeEach(function () {
          packageJson = {
            name: 'derp',
            version: '1.0.0',
            appium: {
              mainClass: 'SomeClass',
              pluginName: 'myPlugin',
            },
          };
        });

        it('should add an extension to the internal data', function () {
          manifest.addExtensionFromPackage(
            packageJson,
            '/some/path/to/package.json',
          );
          expect(manifest.getExtensionData('plugin')).to.deep.equal({
            myPlugin: {
              mainClass: 'SomeClass',
              pkgName: 'derp',
              version: '1.0.0',
              installType: 'npm',
              installSpec: 'derp@1.0.0',
            },
          });
        });

        it('should return `true`', function () {
          expect(
            manifest.addExtensionFromPackage(
              packageJson,
              '/some/path/to/package.json',
            ),
          ).to.be.true;
        });

        describe('when the plugin has already been registered', function () {
          beforeEach(function () {
            manifest.addExtensionFromPackage(
              packageJson,
              '/some/path/to/package.json',
            );
          });

          it('should return `false`', function () {
            expect(
              manifest.addExtensionFromPackage(
                packageJson,
                '/some/path/to/package.json',
              ),
            ).to.be.false;
          });
        });
      });

      describe('when provided a non-extension', function () {
        it('should throw', function () {
          expect(() =>
            manifest.addExtensionFromPackage(
              // @ts-expect-error
              {herp: 'derp'},
              '/some/path/to/package.json',
            ),
          ).to.throw(/neither a valid driver nor a valid plugin/);
        });
      });
    });

    describe('syncWithInstalledExtensions()', function () {
      beforeEach(function () {
        const next = sandbox.stub();
        next.onFirstCall().resolves({
          value: {
            stats: {
              isDirectory: sandbox.stub().returns(true),
            },
            path: '/some/dir',
          },
        });
        next.onSecondCall().resolves({
          done: true,
        });
        MockAppiumSupport.fs.walk.returns(
          /** @type {import('klaw').Walker} */ (
            /** @type {unknown} */ ({
              [Symbol.asyncIterator]: sandbox.stub().returns({
                next,
              }),
            })
          ),
        );
        MockAppiumSupport.env.readPackageInDir.resolves({
          name: 'foo',
          version: '1.0.0',
          readme: 'stuff!',
          _id: 'totally unique',
          appium: {
            automationName: 'derp',
            mainClass: 'SomeClass',
            pkgName: 'derp',
            platformNames: ['dogs', 'cats'],
            driverName: 'myDriver',
          },
        });
      });

      it('should add a found extension', async function () {
        await manifest.syncWithInstalledExtensions();
        expect(manifest.getExtensionData('driver')).to.have.property(
          'myDriver',
        );
      });
    });

    describe('hasDriver()', function () {
      describe('when the driver is registered', function () {
        beforeEach(function () {
          // @ts-expect-error
          manifest.addExtension(DRIVER_TYPE, 'foo', {});
        });

        it('should return `true`', function () {
          expect(manifest.hasDriver('foo')).to.be.true;
        });
      });

      describe('when the driver is not registered', function () {
        it('should return `false`', function () {
          expect(manifest.hasDriver('foo')).to.be.false;
        });
      });
    });

    describe('hasPlugin()', function () {
      describe('when the plugin is registered', function () {
        beforeEach(function () {
          // @ts-expect-error
          manifest.addExtension(PLUGIN_TYPE, 'foo', {});
        });

        it('should return `true`', function () {
          expect(manifest.hasPlugin('foo')).to.be.true;
        });
      });

      describe('when the plugin is not registered', function () {
        it('should return `false`', function () {
          expect(manifest.hasPlugin('foo')).to.be.false;
        });
      });
    });
  });
});

/**
 * @template T
 * @typedef {import('../../../lib/extension/manifest').ExtData<T>} ExtData
 */

/**
 * @template T
 * @typedef {import('../../../lib/extension/manifest').ExtensionPackageJson<T>} ExtensionPackageJson
 */

/**
 * @typedef {import('../../../lib/extension/manifest').DriverType} DriverType
 * @typedef {import('../../../lib/extension/manifest').PluginType} PluginType
 */