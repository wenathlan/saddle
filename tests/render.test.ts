/**
 * real tests for the software rendering stack (render.ts).
 *
 * the suite assembles real mesa environments with the fluent builder,
 * checks the xvfb headless argv recipe, the gpu identity registry and
 * the verified stack anchors; no process is spawned and no value is
 * mocked.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advisethreads,
  defaultgpuregistry,
  gpuprofilebuilder,
  gpuspoofdata,
  lavapipe,
  llvmpipe,
  mesaenvbuilder,
  mesastack,
  pciid,
  randomdisplay,
  renderenv,
  rendererfactory,
  xvfbargs,
  xvfbdisplay,
} from '../render.js';

/* ------------------------------------------------------------------ */
/* stack anchors                                                       */
/* ------------------------------------------------------------------ */

test('mesastack pins the verified mesa, driver and cuda versions', () => {
  assert.equal(mesastack.mesa, '26.2.1');
  assert.equal(mesastack.llvm, '22.1.8');
  assert.equal(mesastack.gl, '4.6');
  assert.equal(mesastack.vulkan, '1.4');
  assert.equal(mesastack.smidriver, '575.57.08');
  assert.equal(mesastack.cudaversion, '12.9');
  assert.equal(llvmpipe.threadceiling, 32);
  assert.equal(lavapipe.icdenv, 'VK_DRIVER_FILES');
  assert.equal(lavapipe.deprecatedicdenv, 'VK_ICD_FILENAMES');
});

/* ------------------------------------------------------------------ */
/* mesa environment builder                                            */
/* ------------------------------------------------------------------ */

test('the mesa builder forces the llvmpipe software path', () => {
  const env = new mesaenvbuilder().software().build();
  assert.equal(env.LIBGL_ALWAYS_SOFTWARE, 'true');
  assert.equal(env.GALLIUM_DRIVER, 'llvmpipe');
});

test('the mesa builder pins the 512-bit vector width', () => {
  const env = new mesaenvbuilder().vectorwidth(512).build();
  assert.equal(env.LP_NATIVE_VECTOR_WIDTH, '512');
});

test('the mesa builder selects lavapipe through vk_driver_files only', () => {
  const env = new mesaenvbuilder().lavapipe().build();
  assert.equal(env.VK_DRIVER_FILES, '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json');
  assert.equal(env.MESA_VK_WSI_HEADLESS_SWAPCHAIN, '1');
  assert.equal(
    'VK_ICD_FILENAMES' in env,
    false,
    'the deprecated loader variable must never be emitted',
  );
});

test('the mesa builder enables rusticl with the gpu device type', () => {
  const env = new mesaenvbuilder().rusticl().build();
  assert.equal(env.RUSTICL_ENABLE, 'llvmpipe');
  assert.equal(env.RUSTICL_DEVICE_TYPE, 'gpu');
  assert.equal(env.RUSTICL_CL_VERSION, '3.1');
  assert.equal(env.RUSTICL_FEATURES, 'fp64');
});

test('the mesa builder bounds rasterizer threads at the 32 ceiling', () => {
  assert.equal(new mesaenvbuilder().threads(0).build().LP_NUM_THREADS, '0');
  assert.equal(new mesaenvbuilder().threads(32).build().LP_NUM_THREADS, '32');
  assert.throws(() => new mesaenvbuilder().threads(33));
  assert.throws(() => new mesaenvbuilder().threads(-1));
});

test('the mesa builder joins lp_perf stages last and overrides gl versions', () => {
  const env = new mesaenvbuilder()
    .glversion('4.6')
    .glslversion('460')
    .perf('no_blend')
    .perf('no_depth')
    .noerror()
    .build();
  assert.equal(env.MESA_GL_VERSION_OVERRIDE, '4.6');
  assert.equal(env.MESA_GLSL_VERSION_OVERRIDE, '460');
  assert.equal(env.MESA_NO_ERROR, '1');
  assert.equal(env.LP_PERF, 'no_blend,no_depth');
});

/* ------------------------------------------------------------------ */
/* render presets and thread advisor                                   */
/* ------------------------------------------------------------------ */

test('the opengl preset carries the software path and the 512-bit width', () => {
  const env = renderenv('opengl');
  assert.equal(env.LIBGL_ALWAYS_SOFTWARE, 'true');
  assert.equal(env.GALLIUM_DRIVER, 'llvmpipe');
  assert.equal(env.LP_NATIVE_VECTOR_WIDTH, '512');
  assert.equal(env.LP_NUM_THREADS, '0');
});

test('the vulkan preset uses vk_driver_files and never the deprecated variable', () => {
  const env = renderenv('vulkan');
  assert.equal(env.VK_DRIVER_FILES, '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json');
  assert.equal('VK_ICD_FILENAMES' in env, false);
});

test('the opencl preset enables rusticl on llvmpipe with device type gpu', () => {
  const env = renderenv('opencl');
  assert.equal(env.RUSTICL_ENABLE, 'llvmpipe');
  assert.equal(env.RUSTICL_DEVICE_TYPE, 'gpu');
});

test('the gles preset spoofs version 3.2', () => {
  const env = renderenv('gles');
  assert.equal(env.MESA_GLES_VERSION_OVERRIDE, '3.2');
  assert.equal(env.LIBGL_ALWAYS_SOFTWARE, 'true');
});

test('advisethreads clamps the host core count to the 32 ceiling', () => {
  assert.equal(advisethreads(4), 4);
  assert.equal(advisethreads(100), 32);
  assert.equal(advisethreads(1), 1);
});

/* ------------------------------------------------------------------ */
/* xvfb headless recipe                                                */
/* ------------------------------------------------------------------ */

test('xvfbargs builds the validated :99 glx command line', () => {
  const args = xvfbargs('99', '1920x1080x24');
  assert.deepEqual(
    [...args],
    [
      ':99',
      '-ac',
      '-screen',
      '0',
      '1920x1080x24',
      '-nolisten',
      'tcp',
      '+extension',
      'GLX',
      '+render',
      '-noreset',
    ],
  );
  assert.ok(args.includes(':99'), 'the xvfb command must bind display :99');
  const ext = args.indexOf('+extension');
  assert.equal(args[ext + 1], 'GLX', 'the +extension flag must be followed by GLX');
});

test('randomdisplay draws from the 90-99 range', () => {
  for (let i = 0; i < 50; i += 1) {
    const display = Number(randomdisplay());
    assert.ok(display >= 90 && display <= 99, `display ${display} outside the 90-99 range`);
  }
});

test('xvfbdisplay exposes the display number and geometry without booting', () => {
  const display = new xvfbdisplay({ display: '99', geometry: '1920x1080x24' });
  assert.equal(display.displaynumber, '99');
  assert.equal(display.geometry, '1920x1080x24');
  assert.equal(display.env.DISPLAY, ':99');
});

/* ------------------------------------------------------------------ */
/* gpu identity registry and profile builder                           */
/* ------------------------------------------------------------------ */

test('the default registry seeds the five verified identities', () => {
  const names = defaultgpuregistry.names();
  assert.deepEqual(names, ['rtx5090', 'rtxpro6000', 'b200', 'rx9070xt', 'mi350x']);
  const pro = defaultgpuregistry.require('rtxpro6000');
  assert.equal(pciid(pro), '10DE:26B5');
  assert.equal(gpuspoofdata.rtxpro6000.pcidevice, '26B5');
  assert.equal(pciid(defaultgpuregistry.require('rtx5090')), '10DE:2B85');
  assert.equal(defaultgpuregistry.get('voodoo3'), undefined);
  assert.throws(() => defaultgpuregistry.require('voodoo3'));
});

test('the gpu profile builder validates and freezes custom identities', () => {
  const built = new gpuprofilebuilder().withname('NVIDIA Test 1').build();
  assert.equal(built.name, 'NVIDIA Test 1');
  assert.equal(built.pcidevice, '2B85');
  const amd = new gpuprofilebuilder()
    .withvendor('amd')
    .withpcidevice('748e')
    .withvram(16384)
    .build();
  assert.equal(amd.pcivendor, '1002');
  assert.equal(amd.pcidevice, '748E');
  assert.throws(() => new gpuprofilebuilder().withname('').build());
  assert.throws(() => new gpuprofilebuilder().withpcidevice('XYZ1').build());
  assert.throws(() => new gpuprofilebuilder().withvram(0).build());
});

/* ------------------------------------------------------------------ */
/* renderer factory                                                    */
/* ------------------------------------------------------------------ */

test('the renderer factory wires each target to its software renderer', () => {
  const factory = new rendererfactory();
  const gl = factory.create('opengl');
  assert.equal(gl.label, 'llvmpipe');
  assert.equal(gl.env.LIBGL_ALWAYS_SOFTWARE, 'true');
  const vk = factory.create('vulkan');
  assert.equal(vk.label, 'lavapipe');
  assert.equal(vk.env.VK_DRIVER_FILES, '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json');
  const cl = factory.create('opencl');
  assert.equal(cl.label, 'rusticl');
  assert.equal(cl.env.RUSTICL_ENABLE, 'llvmpipe');
  const gles = factory.create('gles');
  assert.equal(gles.label, 'llvmpipe');
  assert.equal(gles.env.MESA_GLES_VERSION_OVERRIDE, '3.2');
  assert.throws(() => factory.create('directx' as 'opengl'));
});
