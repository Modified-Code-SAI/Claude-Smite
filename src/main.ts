import * as THREE from 'three/webgpu';
import './style.css';
import { Input } from './core/Input';
import { Loop } from './core/Loop';
import { GodModel } from './actors/GodModel';
import { GOD_IDS, loadGodAsset, preloadGodAssets } from './actors/gods/assets';
import { Showcase } from './dev/Showcase';
import { GiantShowcase } from './dev/GiantShowcase';
import { PlayerController } from './player/PlayerController';
import { ThirdPersonCamera } from './player/ThirdPersonCamera';
import { grading, PostFX } from './render/PostFX';
import { AsyncPipelines } from './render/AsyncPipelines';
import { AutoQuality } from './render/AutoQuality';
import { PerfStats } from './render/PerfStats';
import { shareShaders } from './render/instancing';
import { createRenderer, gpuName } from './render/Renderer';
import { gpuAdvice } from './render/gpuAdvice';
import { Layers } from './render/Layers';
import { initialQuality, QUALITY_PRESETS, saveQuality, type QualityName } from './render/Quality';
import { TextureLibrary } from './scene/Materials';
import { mapFromUrl, World } from './scene/World';
import { Hud } from './ui/Hud';
import { CombatGame } from './combat/CombatGame';
import { parseRole } from './combat/JotunnMode';
import { monsterWarmup } from './combat/MonsterViews';
import { GODS, godById } from './game/gods';
import { parseDifficulty } from './game/difficulty';
import { mapOf, saveChoice, savedMode, savedPick, showStartMenu, type GameMode, type ModeChoice, type StartChoice } from './ui/StartMenu';
import { showGodPick, type PickScreen } from './ui/GodPick';
import { newSeed } from './game/lineup';
import { compatibilityMode, installErrorHandlers, showFatal } from './ui/Fatal';
import { playIntro } from './ui/Intro';
import { Announcer } from './audio/Announcer';
import { AudioEngine } from './audio/AudioEngine';
import { GodVoice } from './audio/GodVoice';
import { bakeAll } from './audio/bank';
import { GameAudio } from './audio/GameAudio';
import { Music } from './audio/music';
import { installUiSounds, mountAudioPanel } from './ui/AudioPanel';
import { slice } from './core/slices';
import { applyPageSettings } from './settings/apply';
import { actionForCode, keyGate, onSettings, settings } from './settings/store';
import { closeSettings, mountSettings, openSettings, setGraphicsHooks, settingsOpen, typing } from './ui/SettingsMenu';
import { escapeKey, mountPadCursor, padCursor } from './ui/PadCursor';
import { pad } from './core/Gamepad';
import { mountSubtitles } from './ui/Subtitles';

async function main(): Promise<void> {
  installErrorHandlers();
  const perf = new PerfStats();
  let applyQuality: (q: QualityName) => Promise<void> = async () => {};
  let autoQuality: AutoQuality | null = null;
  const hud = new Hud((q) => {
    autoQuality?.stop();
    void applyQuality(q);
  });
  hud.progress(0.05, 'Starting renderer…');

  const params = new URLSearchParams(location.search);
  // Sound starts with the first click or key press (browsers require a gesture);
  // the bank renders in small slices while everything else loads.
  const audio = new AudioEngine();
  const music = new Music(audio);
  const herald = new Announcer(audio);
  // the player's settings reach the page first (team colors, HUD size, keys), then the menus
  applyPageSettings(audio);
  mountAudioPanel(audio);
  mountSettings(audio);
  mountSubtitles();
  mountPadCursor();
  installUiSounds(audio);
  const baked = bakeAll(audio);
  (window as unknown as { __audio: unknown }).__audio = { audio, music, herald, baked };
  // Links with ?map= (and automated captures) skip the title screen.
  const skipMenu = params.has('map') || params.has('capture') || params.has('showcase') || params.has('giant') || params.has('stage');
  const rendering = createRenderer(document.body);
  const graphics = rendering.then((r) => {
    const gpu = gpuName(r.renderer);
    return { webgpu: r.isWebGPU, gpu, advice: gpuAdvice(gpu) };
  });
  // each god (and the giant) says who it is when picked
  let voice: GodVoice | null = null;
  const menu = {};
  const say = (id: string) => voice?.say(menu, id, 'select', { own: true, cut: true, gain: 0.9 });
  // a normal launch opens on the home page and the intro trailer; the mode
  // select (and its hymn) follows once the trailer ends or is skipped, then
  // the god pick once a mode is started
  const chosen: Promise<StartChoice | ModeChoice> = skipMenu
    ? Promise.resolve({ mode: (['clash', 'siege', 'duel', 'rush', 'descent', 'jotunn'].includes(params.get('map') ?? '') ? params.get('map') : mapFromUrl()) as GameMode, god: godById(params.get('god') ?? '')?.id ?? 'zeus', difficulty: parseDifficulty(params.get('difficulty')), rival: params.get('rival') ?? undefined, allies: params.get('allies') !== '0', rivals: params.get('rivals') === '1' })
    : playIntro(audio).then(() => {
        music.play('hymn');
        voice = new GodVoice(audio, import.meta.env.BASE_URL);
        for (const g of GODS) voice.load(g.id, ['select']);
        voice.load('jotunn', ['select']);
        return showStartMenu(graphics, savedPick().god ?? GODS[0]!.id, say);
      });

  const { renderer, isWebGPU } = await rendering;
  const { gpu, advice: slowGpu } = await graphics;
  // shaders compile in parallel in the background and never freeze a frame
  const pipelines = new AsyncPipelines(renderer);
  shareShaders(renderer);
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 3000);
  camera.layers.enable(Layers.NEAR_SHADOW);

  // textures and god models load behind the title screen
  const textures = new TextureLibrary(renderer.getMaxAnisotropy?.() ?? 8);
  await textures.load((f) => hud.progress(0.05 + f * 0.5, 'Quarrying marble…'));

  await preloadGodAssets((f) => hud.progress(0.55 + f * 0.05, 'Summoning the gods…'));

  let quality = QUALITY_PRESETS[initialQuality(isWebGPU, slowGpu !== null)];
  // before the match, a pick in Settings only takes the new preset (the map is built with it, or
  // brought up to it once Play is pressed)
  applyQuality = async (name: QualityName) => {
    quality = QUALITY_PRESETS[name];
    saveQuality(name);
    hud.setQuality(name);
  };
  setGraphicsHooks({
    quality: () => quality.name,
    setQuality: (q) => {
      autoQuality?.stop();
      void applyQuality(q);
    },
    webgpu: isWebGPU,
  });
  /** Lowered by AutoQuality when the frame rate stays low. */
  let renderScale = 1;
  let autoDrops = 0;
  const resize = () => {
    // (Settings > Graphics > Render resolution scales on top of the preset and the automatic drops)
    const pr = Math.min(window.devicePixelRatio * quality.resolutionScale, quality.maxPixelRatio) * renderScale * settings().resolution;
    renderer.setPixelRatio(pr);
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  /**
   * Draws hidden frames of everything (the whole map unculled, every shadow
   * cascade) until no draw is left waiting for its shader, so shaders are
   * generated now rather than mid-match. These are the real passes and render
   * targets: `compileAsync` only reaches a stand-in of the scene pass (measured:
   * 470 of its shaders were never used). A quarter second's worth per frame
   * keeps the loading screen moving, and the frames send no draws to the GPU.
   */
  const prepareShaders = async (world: World, post: PostFX, from: number, to: number): Promise<void> => {
    pipelines.limitShaderBuilds(250);
    pipelines.preparing = true;
    const cull = world.showEverything();
    const start = pipelines.built;
    for (;;) {
      // a new frame number each time: passes render once per frame
      await new Promise((r) => requestAnimationFrame(r));
      world.environment.redrawShadows();
      const waiting = pipelines.deferred;
      post.render();
      const left = pipelines.deferred - waiting;
      const done = pipelines.built - start;
      hud.progress(from + ((to - from) * done) / (done + left || 1), `Preparing materials ${done}…`);
      if (left === 0) break;
    }
    cull();
    pipelines.preparing = false;
  };

  /** The map being built, so a second one waits its turn. */
  let building: Promise<unknown> = Promise.resolve();
  /**
   * Builds the map, lights it and prepares its shaders, plus every god's (and the
   * jungle's in Conquest), so pressing Play only has the little that is left to do.
   */
  const prepare = async (mode: GameMode) => {
    hud.progress(0.6, mode === 'conquest' ? 'Raising the battlefield…' : mode === 'descent' ? 'Opening the underworld…' : 'Raising the temple…');
    // a guess behind the title screen may still be building
    const build = () => World.create(textures, camera, mapOf(mode));
    const world = await (building = building.then(build, build));
    const post = new PostFX(renderer, world.scene, camera);
    hud.progress(0.8, 'Lighting the braziers…');
    resize();
    await world.applyQuality(renderer, quality);
    await slice();
    post.build(quality);
    await slice();
    world.bakeLighting(renderer);
    await slice();
    hud.progress(0.85, 'Preparing shaders…');
    // the lights a match starts with: the pool at the fires nearest the spawn
    // (the map's spell lights are already in place)
    world.update(0, 0, new THREE.Vector3(world.spawn.x, 0, world.spawn.z));
    // every god and monster, kept until the match's own last preparation
    const models = new THREE.Group();
    for (const g of GODS) {
      models.add(new GodModel(g.id).root);
      await slice();
    }
    // Odin's Einherjar (summons are drawn on the fallback god's body, in their own colors)
    models.add(new GodModel('zeus', 'einherjar').root);
    if (mode === 'conquest' || mode === 'siege' || mode === 'descent') for (const root of monsterWarmup()) models.add(root);
    // the frost giant's model loads only for its own mode
    if (mode === 'jotunn') await loadGodAsset('jotunn');
    world.actors.add(models);
    await prepareShaders(world, post, 0.85, 0.86);
    return { world, post, models, builtWith: quality };
  };
  // Start on the mode the title screen opens with (the last one played) while
  // the player picks a god; a different pick builds its own map after Play.
  const guessMode = skipMenu ? null : savedMode();
  const guess = guessMode ? prepare(guessMode) : null;
  const started = await chosen;
  // A map built for the other mode is left to the garbage collector, not disposed:
  // it shares cached geometry with the new map, and disposing destroys GPU
  // buffers that the new map still draws ("buffer used in submit while destroyed").
  const reuse = guess && mapOf(guessMode!) === mapOf(started.mode);
  // the match's map builds while everyone picks a god
  const loading = reuse ? guess : prepare(started.mode);
  let pickScreen: PickScreen | null = null;
  let choice: StartChoice;
  if ('god' in started) choice = started;
  else {
    const seed = newSeed();
    const last = savedPick();
    pickScreen = showGodPick({
      mode: started.mode,
      net: started.net,
      gods: GODS,
      god: last.god ?? GODS[0]!.id,
      rival: last.rival,
      allies: started.allies,
      rivals: started.rivals,
      role: started.role,
      seed,
      say,
      sound: (name, gain = 0.8) => audio.play(name, { bus: 'ui', gain }, 4, 0.05),
    });
    hud.mirrorProgress((f, text) => pickScreen!.progress(f, text));
    hud.notesHost = pickScreen.notes;
    const picked = await pickScreen.chosen;
    // online the host's roster decides the bots; alone the seed the screen showed does
    choice = { ...started, god: picked.god, rival: picked.rival, seed: started.net ? undefined : seed };
    saveChoice({ god: picked.god, rival: picked.rival });
  }
  const { world, post, models, builtWith } = await loading;
  // a quality picked in Settings on the home page, after the map was built
  if (builtWith !== quality) {
    resize();
    await world.applyQuality(renderer, quality);
    post.build(quality);
  }

  const input = new Input(renderer.domElement);
  const god = new GodModel();
  world.actors.add(god.root);
  const player = new PlayerController(input, world.collision, god);
  const baseSensitivity = player.mouseSensitivity;
  player.spawn(world.spawn.x, world.spawn.z, world.spawn.yaw);
  const follow = new ThirdPersonCamera(camera, player, world.collision);
  // models only one mode uses (the Jötunn) load on demand
  for (const id of (params.get('showcase') ?? '').split(',')) if (id && !(GOD_IDS as readonly string[]).includes(id)) await loadGodAsset(id);
  const showcase = params.has('showcase')
    ? new Showcase(params, world.actors, world.spawn, (x, z) => world.collision.groundAt(x, z), camera)
    : null;
  const giant = params.has('giant') ? await GiantShowcase.create(params, world.actors, world.spawn, (x, z) => world.collision.groundAt(x, z), camera) : null;
  if (showcase || giant) {
    god.root.visible = false;
    follow.update = () => {};
  }

  applyQuality = async (name: QualityName) => {
    quality = QUALITY_PRESETS[name];
    autoStopped = true;
    autoQuality = null;
    renderScale = 1;
    saveQuality(name);
    hud.setQuality(name);
    resize();
    await world.applyQuality(renderer, quality);
    post.build(quality);
  };
  hud.setQuality(quality.name);
  hud.setInfo(`${isWebGPU ? 'WebGPU' : 'WebGL 2'}${gpu ? ` · ${gpu}` : ''}`);
  const advice = params.has('capture') ? null : slowGpu;
  // a quality forced in the URL (tests, shared links) stays put, and so does one the player picked
  let autoStopped = params.has('quality');
  const startAuto = () => {
    autoQuality = new AutoQuality((scale) => {
      renderScale = scale;
      autoDrops++;
      resize();
      hud.notice(`Lowered the render resolution to ${Math.round(scale * 100)}% for a smoother frame rate. Picking a quality, or turning off Automatic resolution in Settings, resets it.`);
    }, () => perf.gpuAverage(4));
  };
  const stopAuto = () => {
    autoQuality?.stop();
    autoQuality = null;
    if (renderScale !== 1) {
      renderScale = 1;
      resize();
    }
  };

  // the settings that need the camera, the player and the renderer
  const fixedCamera = !!(showcase || giant || params.has('stage'));
  const baseExposure = grading.exposure.value;
  onSettings((s, changed) => {
    player.mouseSensitivity = baseSensitivity * s.sensitivity;
    player.invertY = s.invertY;
    if (changed.has('fov') && !fixedCamera) {
      camera.fov = s.fov;
      camera.updateProjectionMatrix();
    }
    grading.exposure.value = baseExposure * s.brightness;
    if (changed.has('resolution')) resize();
    if (changed.has('autoResolution')) {
      if (!s.autoResolution) stopAuto();
      else if (!autoStopped && !autoQuality) startAuto();
    }
    if (autoQuality) autoQuality.minFps = s.frameCap ? Math.min(45, s.frameCap * 0.85) : 45;
  });

  const loop = new Loop();
  loop.addFixed(player);
  // Conquest plays a full match against bots; the arena is the training ground
  const combat = new CombatGame({ world, input, player, camera, mode: choice.mode, god: choice.god, net: choice.net, difficulty: choice.difficulty, rival: choice.rival, allies: choice.allies, rivals: choice.rivals, seed: choice.seed, shake: (a) => {
    follow.addShake(a * settings().shake);
    pad.rumble(a * 1.6);
  }, cameraShot: (s) => (follow.shot = s), role: parseRole(params.get('role') ?? choice.role), cameraScale: (k, lift, side, ahead) => follow.setScale(k, lift, side, ahead) });
  loop.addFixed(combat);
  void baked;
  // `?stage`: the trailer's film set (tools/trailer)
  const stage = params.has('stage') ? new (await import('./dev/Stage')).Stage(combat, camera, () => (player.model.root.visible = false)) : null;
  if (stage) follow.update = () => {};
  const gameAudio = new GameAudio(audio, music, herald, combat, camera, choice.mode === 'conquest', () => !player.grounded);
  // Prepare what the match added (the player, spell effects, structures), every
  // god and monster still included, then wait (bounded) for the driver to
  // finish compiling the pipelines before revealing the scene.
  player.render(0, 1);
  follow.update(1 / 60);
  world.update(0, 0, player.model.root.position);
  const slow = setTimeout(() => hud.slowLoad(isWebGPU), 15000);
  const effects = combat.prime();
  await prepareShaders(world, post, 0.86, 0.9);
  effects();
  models.removeFromParent();
  await pipelines.settle(60000, (done, total) => hud.progress(0.9 + (total ? (0.1 * done) / total : 0.1), `Preparing shaders ${done} / ${total}…`));
  clearTimeout(slow);
  hud.ready();
  pickScreen?.finish();
  if (advice) hud.notice(advice.text, 15);
  const shadersAtStart = pipelines.built;
  const deferredAtStart = pipelines.deferred;
  const builtForAtStart = new Map(pipelines.builtFor);
  perf.watchGpu(renderer);
  // (automated captures want every object in the frame they ask for)
  pipelines.limitShaderBuilds(params.has('capture') ? Infinity : 4);
  hud.report = () => perf.report({
    gpu,
    backend: isWebGPU ? 'WebGPU' : `WebGL 2 (${compatibilityMode() ? 'compatibility switch on' : 'gpu' in navigator ? 'WebGPU failed to start' : 'no WebGPU in this browser'})`,
    quality: quality.label,
    renderScale,
    autoDrops,
    canvas: renderer.domElement,
    mode: `${choice.mode}${choice.net ? ' online' : ''}`,
    shaders: pipelines.built - shadersAtStart,
    deferred: pipelines.deferred - deferredAtStart,
    shadersFor: new Map([...pipelines.builtFor].map(([what, n]) => [what, n - (builtForAtStart.get(what) ?? 0)] as const).filter(([, n]) => n > 0)),
  });
  combat.netReady();

  window.addEventListener('keydown', (e) => {
    if (!e.repeat && !keyGate.blocked && !typing(e) && actionForCode(e.code) === 'menu') hud.toggleHelp();
  });
  document.addEventListener('pointerlockchange', () => hud.setLocked(input.engaged));
  pad.onChange(() => hud.setLocked(input.engaged));
  // a controller runs the menus with its cursor, and plays when none is up
  padCursor.wanted = () => settingsOpen() || hud.helpOpen || combat.menuUp;
  padCursor.back = () => {
    if (settingsOpen()) closeSettings();
    else if (hud.helpOpen) hud.toggleHelp(false);
    else escapeKey();
  };

  /** When the next frame is due under Settings > Graphics > Frame rate cap. */
  let nextFrame = 0;
  const frame = (now: number) => {
    const cap = captureMode ? 0 : settings().frameCap;
    if (cap) {
      // a frame the cap holds back draws nothing: the screen keeps the last one
      if (now < nextFrame - 1) return;
      const interval = 1000 / cap;
      nextFrame = Math.max(nextFrame + interval, now - interval);
    }
    perf.begin(now);
    input.beginFrame();
    // the controller's interface buttons (the keyboard's go through keydown)
    if (input.padActionPressed('menu')) hud.toggleHelp();
    if (input.padActionPressed('settings')) openSettings();
    if (input.padActionPressed('mute')) audio.setSettings({ muted: !audio.settings.muted });
    player.look();
    const wheel = input.consumeWheel();
    if (wheel) follow.zoom(wheel);
    const dt = loop.tick(now);
    perf.mark(0);
    player.render(dt, loop.alpha);
    combat.frame(dt, loop.alpha, loop.time);
    gameAudio.frame(dt);
    showcase?.update(dt);
    giant?.update(dt);
    stage?.update(dt);
    follow.update(dt);
    perf.mark(1);
    world.update(dt, loop.time, player.model.root.position);
    perf.mark(2);
    post.render();
    perf.mark(3);
    input.endFrame();
    hud.frame(dt);
    // (not inside the call below: `?.` would skip it when auto quality is off)
    const cpu = perf.end(pipelines.built, pipelines.draws);
    // the real interval: the loop's dt is clamped to 100 ms, which would make a
    // very slow GPU look CPU bound and hide stalls from auto quality
    autoQuality?.frame(perf.gap / 1000, cpu);
  };
  // `?capture` leaves the loop stopped so automated screenshots can step frames
  // themselves (software GPUs in CI can't keep up with a live loop).
  const captureMode = new URLSearchParams(location.search).has('capture');
  if (!captureMode) renderer.setAnimationLoop(frame);

  /**
   * Deterministic capture for automated screenshots: stops the live loop,
   * renders `frames` frames at a fixed 60 Hz (so temporal AA converges) and
   * returns the canvas as a PNG data URL. `capture(0, 1000 / 30)` films one
   * frame of 30 fps footage (tools/trailer).
   */
  let simNow = 0;
  const capture = async (frames = 8, step = 1000 / 60): Promise<string> => {
    renderer.setAnimationLoop(null);
    // continue from the live clock if the loop already ran, so time never steps backwards
    if (simNow === 0) simNow = performance.now();
    const device = (renderer.backend as unknown as { device?: { queue: { onSubmittedWorkDone(): Promise<void> } } }).device;
    for (let i = 0; i < frames; i++) {
      frame((simNow += step));
      await device?.queue.onSubmittedWorkDone();
    }
    await new Promise((r) => requestAnimationFrame(r));
    frame((simNow += step));
    const url = renderer.domElement.toDataURL('image/png');
    await device?.queue.onSubmittedWorkDone();
    return url;
  };

  // Hooks for automated screenshots and for gameplay code during development.
  const debug = { giant, stage, perf, pipelines, grading, combat, audio, music, herald, world, player, camera, follow, renderer, post, setQuality: applyQuality, isWebGPU, capture, resume: () => renderer.setAnimationLoop(frame) };
  (window as unknown as { __game: typeof debug }).__game = debug;
}

main().catch((err) => {
  showFatal('The game failed to start.', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
});
