// PonderViewer: three.js shell that shows a Ponder scene exactly like the game's Ponder screen does
// (orthographic GUI projection, Ponder SceneTransform camera, Ponder lighting, base-plate shadow, blurred sky/ground),
// plus free orbit / zoom / pan by mouse, touch and keyboard on top of the authentic camera.
//
// See camera.ts for the camera port and how scripted camera moves compose with user orbit, environment.ts for the
// lighting / shadow / sky.  Scene content (sections, block-entity visuals, outlines...) is added by the caller to
// `viewer.world`, whose origin is the scene block (0,0,0) corner, x east, y up, z south (Minecraft axes).
//
// Camera clock: Ponder advances its camera once per game tick (20 Hz) and interpolates with the partial tick.  By
// default the viewer runs that clock in real time.  A scene player that pauses / seeks should call
// `setCameraClock('manual')` and drive `tickCamera()` + `setPartialTicks()` itself (or `settleCamera()` after a seek).

import * as THREE from 'three';
import type { Vec3 } from '../contract';
import {
  PonderCameraController,
  guiScaleFor,
  ponderProjection,
  ponderViewMatrix,
  type BasePlate,
  type CameraLimits,
  type CameraState,
  type UserCamera,
} from './camera';
import { PlateShadow, PonderLighting, createSkyTexture } from './environment';

export interface ViewerOptions {
  antialias?: boolean;
  /** force a gui scale (css px per GUI unit); default: Minecraft's auto scale (see guiScaleFor) */
  guiScale?: number;
  /** where arrow keys etc. are listened to: the window (default), only while the container has focus, or nowhere */
  keyboard?: 'window' | 'focus' | 'off';
  /** orbit inertia after releasing a drag; off by default */
  inertia?: boolean;
  /** double click / double tap on the canvas resets to the Ponder camera (default true) */
  doubleClickReset?: boolean;
  /** device pixel ratio cap (default 3) */
  maxPixelRatio?: number;
  /** degrees of rotation per css pixel dragged */
  rotateSpeed?: number;
}

export interface ScreenPoint {
  /** css px relative to the container's top-left corner */
  x: number;
  y: number;
  /** inside the viewport (and inside the depth range) */
  visible: boolean;
}

export interface PickHit {
  /** integer block position containing the hit */
  pos: Vec3;
  point: Vec3;
  /** face normal in scene space */
  normal: Vec3;
  object: THREE.Object3D;
  distance: number;
}

export interface CameraInfo extends CameraState {
  scripted: CameraState;
  user: UserCamera;
  guiScale: number;
}

/** drag right => scene follows the finger (verified by tools/a2-interaction-test.mjs) */
const YAW_PER_PX_SIGN = 1;

export class PonderViewer {
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** Scene content root. Origin = scene block (0,0,0) corner. */
  readonly world = new THREE.Group();
  readonly camera = new THREE.Camera();
  readonly lighting = new PonderLighting();
  readonly shadow = new PlateShadow();
  readonly cameraCtl = new PonderCameraController();
  readonly options: Required<ViewerOptions>;

  private sky: THREE.Texture;
  private bounds: Vec3 = [1, 1, 1];
  private plateExplicit = false;
  private frameCbs: ((timeMs: number) => void)[] = [];
  private userCbs: (() => void)[] = [];
  private running = false;
  private raf = 0;
  private disposed = false;
  private lastNow = 0;
  private clockMode: 'realtime' | 'manual' = 'realtime';
  private tickAcc = 0;
  private partial = 0;
  private orbitEnabled = true;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private guiScaleValue = 1;
  private viewM = new THREE.Matrix4();
  private projM = new THREE.Matrix4();
  private resizeObs?: ResizeObserver;
  private cleanup: (() => void)[] = [];
  private keys = new Set<string>();
  private shiftHeld = false;
  private frameMs: number[] = [];
  private cpuMs: number[] = [];
  autoPatchLighting = true;

  constructor(container: HTMLElement, options: ViewerOptions = {}) {
    this.container = container;
    this.options = {
      antialias: options.antialias ?? true,
      guiScale: options.guiScale ?? 0,
      keyboard: options.keyboard ?? 'window',
      inertia: options.inertia ?? false,
      doubleClickReset: options.doubleClickReset ?? true,
      maxPixelRatio: options.maxPixelRatio ?? 3,
      rotateSpeed: options.rotateSpeed ?? 0.4,
    };

    // ---- GL ----
    // Colours are blended / multiplied in sRGB space exactly like Minecraft does; three's default sRGB output with
    // sRGB-tagged textures is an identity round trip, and the lighting patch multiplies in encoded space.
    this.renderer = new THREE.WebGLRenderer({ antialias: this.options.antialias, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.sortObjects = true;
    this.canvas = this.renderer.domElement;
    const st = this.canvas.style;
    st.display = 'block';
    st.position = 'absolute';
    st.inset = '0';
    st.width = '100%';
    st.height = '100%';
    st.touchAction = 'none'; // no page scroll / browser pinch zoom while interacting with the scene
    st.userSelect = 'none';
    (st as unknown as Record<string, string>).webkitUserSelect = 'none';
    (st as unknown as Record<string, string>).webkitTouchCallout = 'none';
    st.outline = 'none';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
    container.style.outline = 'none';
    container.style.touchAction = 'none';
    container.appendChild(this.canvas);

    this.sky = createSkyTexture();
    this.scene.background = this.sky;
    this.scene.add(this.world);
    this.scene.add(this.shadow.group);

    // custom camera: matrices are written every frame from the Ponder transform
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;

    this.cameraCtl.plate = { x: 0, z: 0, size: 1 };
    this.shadow.setPlate(this.cameraCtl.plate);

    this.resize();
    this.installResize();
    this.installInput();
    this.installVisibility();
    this.updateCamera();
  }

  // ------------------------------------------------------------------------------------------ scene description

  /** Scene bounds (blocks). Unless setBasePlate() was called, the plate is assumed to be sizeX wide at offset 0 (PonderScene ctor). */
  setBounds(sizeX: number, sizeY: number, sizeZ: number): void {
    this.bounds = [sizeX, sizeY, sizeZ];
    if (!this.plateExplicit) this.applyPlate({ x: 0, z: 0, size: sizeX });
  }

  /** SceneBuilder.configureBasePlate(xOffset, zOffset, basePlateSize) */
  setBasePlate(p: { x: number; z: number; size: number }): void {
    this.plateExplicit = true;
    this.applyPlate({ x: p.x, z: p.z, size: p.size });
  }

  getBounds(): Vec3 {
    return [...this.bounds] as Vec3;
  }

  private applyPlate(p: BasePlate): void {
    this.cameraCtl.plate = p;
    this.shadow.setPlate(p);
  }

  /** SceneBuilder.removeShadow() */
  setShadowHidden(hidden: boolean): void {
    this.shadow.hidden = hidden;
  }

  /** PonderUI.finishingFlash (0..1) */
  setFinishingFlash(v: number): void {
    this.shadow.setFlash(v);
  }

  // ------------------------------------------------------------------------------------------ camera API

  /**
   * Set the scripted (Ponder) camera immediately: yaw = SceneTransform.yRotation (default 145), pitch = xRotation
   * (default -35), zoom = scaleSceneView factor, offsetY = setSceneOffsetY.  User orbit offsets are kept unless
   * `opts.keepUser === false`.
   */
  setCamera(c: Partial<CameraState>, opts: { keepUser?: boolean } = {}): void {
    this.cameraCtl.setScripted(c);
    if (opts.keepUser === false) this.cameraCtl.resetUser(false);
    this.updateCamera();
  }

  /** Effective camera (scripted + user), plus the two parts separately. */
  getCamera(): CameraInfo {
    const eff = this.cameraCtl.effective(this.partial);
    return { ...eff, scripted: this.cameraCtl.scripted(this.partial), user: { ...this.cameraCtl.user }, guiScale: this.guiScaleValue };
  }

  /** Animated scripted rotation to absolute angles over `ticks` game ticks (linear, LerpedFloat.chaseTimed). User offsets are untouched. */
  rotateCameraTo(yaw: number, pitch: number, ticks: number): void {
    this.cameraCtl.rotateTo(yaw, pitch, ticks);
    if (ticks <= 0) this.updateCamera();
  }

  /** Ponder's rotateCameraY(degrees): RELATIVE rotation chased exponentially (factor 0.1 per tick). */
  rotateCameraBy(dYaw: number, dPitch = 0): void {
    this.cameraCtl.rotateBy(dYaw, dPitch);
  }

  /** RotateSceneInstruction with absolute target, exponential chase. */
  rotateCameraChase(yaw: number, pitch: number): void {
    this.cameraCtl.rotateToChase(yaw, pitch);
  }

  /** Remove all user orbit/zoom/pan so the authentic Ponder camera (scripted state) is shown. */
  resetCamera(animate = true): void {
    this.cameraCtl.resetUser(animate);
    if (!animate) this.updateCamera();
    this.emitUser();
  }

  /** true when the user has moved away from the Ponder camera */
  get userCameraActive(): boolean {
    return this.cameraCtl.userActive;
  }

  setUserCamera(u: Partial<UserCamera>): void {
    this.cameraCtl.setUser(u);
    this.updateCamera();
  }

  setCameraLimits(l: Partial<CameraLimits>): void {
    Object.assign(this.cameraCtl.limits, l);
  }

  setCameraClock(mode: 'realtime' | 'manual'): void {
    this.clockMode = mode;
    this.tickAcc = 0;
  }

  /** advance Ponder's scripted camera by `n` game ticks (manual clock) */
  tickCamera(n = 1): void {
    for (let i = 0; i < n; i++) this.cameraCtl.tick();
  }

  setPartialTicks(pt: number): void {
    this.partial = Math.min(1, Math.max(0, pt));
  }

  /** jump scripted camera to where its chasers are heading (after seeking) */
  settleCamera(): void {
    this.cameraCtl.settleScripted();
    this.updateCamera();
  }

  setOrbitEnabled(on: boolean): void {
    this.orbitEnabled = on;
    if (!on) {
      this.pointers.clear();
      this.keys.clear();
    }
  }

  get orbitIsEnabled(): boolean {
    return this.orbitEnabled;
  }

  /** css px per GUI unit currently in use (Ponder UI positions are in GUI units). */
  get guiScale(): number {
    return this.guiScaleValue;
  }

  setGuiScale(s: number | undefined): void {
    this.options.guiScale = s ?? 0;
    this.resize();
  }

  /** called whenever the user changes the camera by input */
  onUserCamera(cb: () => void): () => void {
    this.userCbs.push(cb);
    return () => (this.userCbs = this.userCbs.filter((f) => f !== cb));
  }
  private emitUser(): void {
    for (const f of this.userCbs) f();
  }

  // ------------------------------------------------------------------------------------------ frame loop

  /** callback invoked every frame before rendering (use it to update animations) */
  onFrame(cb: (timeMs: number) => void): () => void {
    this.frameCbs.push(cb);
    return () => (this.frameCbs = this.frameCbs.filter((f) => f !== cb));
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastNow = performance.now();
    if (!document.hidden) this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private loop = (now: number): void => {
    if (!this.running || this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.renderFrame(now);
  };

  /** One full frame (clock, callbacks, camera, render). Public so tests / screenshots can force a frame. */
  renderFrame(now = performance.now()): void {
    const t0 = performance.now();
    const dt = Math.min(100, Math.max(0, now - this.lastNow));
    if (this.lastNow) this.frameMs.push(now - this.lastNow);
    this.lastNow = now;

    if (this.dpr !== Math.min(window.devicePixelRatio || 1, this.options.maxPixelRatio)) this.resize();

    this.applyKeys(dt / 1000);
    this.applyInertia(dt / 1000);
    if (this.clockMode === 'realtime') {
      this.tickAcc += dt;
      while (this.tickAcc >= 50) {
        this.cameraCtl.tick();
        this.tickAcc -= 50;
      }
      this.partial = this.tickAcc / 50;
    }

    for (const cb of this.frameCbs) cb(now);

    this.updateCamera();
    if (this.autoPatchLighting) this.lighting.patchTree(this.world);
    this.shadow.update();
    if (this.cssW > 0 && this.cssH > 0) this.renderer.render(this.scene, this.camera);

    this.cpuMs.push(performance.now() - t0);
    if (this.frameMs.length > 120) this.frameMs.shift();
    if (this.cpuMs.length > 120) this.cpuMs.shift();
  }

  /** wall-clock frame interval and CPU time per frame (ms) over the last <=120 frames */
  getFrameStats(): { frameMs: number; fps: number; cpuMs: number; frames: number } {
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const f = avg(this.frameMs);
    return { frameMs: f, fps: f > 0 ? 1000 / f : 0, cpuMs: avg(this.cpuMs), frames: this.cpuMs.length };
  }

  private installVisibility(): void {
    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(this.raf); // the loop sleeps while the tab is hidden
        this.raf = 0;
      } else if (this.running && !this.raf) {
        this.lastNow = performance.now();
        this.raf = requestAnimationFrame(this.loop);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    this.cleanup.push(() => document.removeEventListener('visibilitychange', onVis));
  }

  // ------------------------------------------------------------------------------------------ matrices / projection

  /** Recompute camera matrices from the current state (idempotent, cheap). */
  updateCamera(): void {
    const p = this.cameraCtl.viewParams(this.cssW || 1, this.cssH || 1, this.guiScaleValue, this.partial);
    ponderViewMatrix(p, this.viewM);
    ponderProjection(p.guiW, p.guiH, this.projM);
    const cam = this.camera;
    cam.projectionMatrix.copy(this.projM);
    cam.projectionMatrixInverse.copy(this.projM).invert();
    cam.matrixWorldInverse.copy(this.viewM);
    cam.matrixWorld.copy(this.viewM).invert();
    cam.matrix.copy(cam.matrixWorld);
    this.lighting.update(p.xRot, p.yRot);
  }

  /** scene (block) coordinates -> css px in the container */
  projectToScreen(v: Vec3 | THREE.Vector3): ScreenPoint {
    this.updateCamera();
    const p = Array.isArray(v) ? new THREE.Vector3(v[0], v[1], v[2]) : v.clone();
    const ndc = p.applyMatrix4(this.viewM).applyMatrix4(this.projM);
    const x = (ndc.x * 0.5 + 0.5) * this.cssW;
    const y = (-ndc.y * 0.5 + 0.5) * this.cssH;
    const visible = ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1 && ndc.z >= -1 && ndc.z <= 1;
    return { x, y, visible };
  }

  /** ray through a client-space point, in scene coordinates */
  rayFromClient(clientX: number, clientY: number): THREE.Ray {
    this.updateCamera();
    const r = this.canvas.getBoundingClientRect();
    const nx = ((clientX - r.left) / r.width) * 2 - 1;
    const ny = -(((clientY - r.top) / r.height) * 2 - 1);
    const inv = new THREE.Matrix4().multiplyMatrices(this.projM, this.viewM).invert();
    const a = new THREE.Vector3(nx, ny, -1).applyMatrix4(inv);
    const b = new THREE.Vector3(nx, ny, 1).applyMatrix4(inv);
    return new THREE.Ray(a, b.sub(a).normalize());
  }

  /** Nearest hit of the scene meshes under a client-space point (details), or null. */
  pickHit(clientX: number, clientY: number): PickHit | null {
    this.world.updateMatrixWorld(true);
    const rc = new THREE.Raycaster();
    rc.near = 0;
    rc.far = Infinity;
    let h: THREE.Intersection | undefined;
    // a ray that lands exactly on a triangle diagonal / shared edge can slip between two triangles: retry with
    // sub-pixel jitter before reporting a miss
    for (const [jx, jy] of [[0, 0], [0.3, 0.1], [-0.2, 0.3], [0.1, -0.3]]) {
      rc.ray.copy(this.rayFromClient(clientX + jx, clientY + jy));
      h = rc.intersectObjects(this.world.children, true).filter((x) => x.object.visible && (x.object as THREE.Mesh).isMesh)[0];
      if (h) break;
    }
    if (!h) return null;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    const inside = h.point.clone().addScaledVector(n, -0.01);
    return {
      pos: [Math.floor(inside.x), Math.floor(inside.y), Math.floor(inside.z)],
      point: [h.point.x, h.point.y, h.point.z],
      normal: [n.x, n.y, n.z],
      object: h.object,
      distance: h.distance,
    };
  }

  /** Integer block position of the nearest mesh under a client-space point, or null (PonderScene.rayTraceScene). */
  pick(clientX: number, clientY: number): Vec3 | null {
    return this.pickHit(clientX, clientY)?.pos ?? null;
  }

  // ------------------------------------------------------------------------------------------ misc

  screenshot(): Promise<Blob> {
    this.renderFrame();
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.options.maxPixelRatio);
    this.cssW = w;
    this.cssH = h;
    this.guiScaleValue = guiScaleFor(w, h, this.options.guiScale || undefined);
    this.renderer.setPixelRatio(this.dpr);
    if (w > 0 && h > 0) this.renderer.setSize(w, h, false);
    this.updateCamera();
  }

  get size(): { width: number; height: number; pixelRatio: number } {
    return { width: this.cssW, height: this.cssH, pixelRatio: this.dpr };
  }

  private installResize(): void {
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.container);
    const onWin = () => this.resize();
    window.addEventListener('resize', onWin);
    window.addEventListener('orientationchange', onWin);
    this.cleanup.push(() => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('orientationchange', onWin);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.resizeObs?.disconnect();
    for (const c of this.cleanup) c();
    this.cleanup = [];
    this.shadow.dispose();
    this.sky.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ------------------------------------------------------------------------------------------ user input

  private pointers = new Map<number, { x: number; y: number; type: string; button: number; shift: boolean }>();
  private gesture: { dist: number; mx: number; my: number } | null = null;
  private vel = { yaw: 0, pitch: 0 };
  private lastMoveT = 0;
  private lastTapT = 0;
  private lastTapX = 0;
  private lastTapY = 0;

  private installInput(): void {
    const c = this.canvas;
    const opt = { passive: false } as AddEventListenerOptions;
    const down = (e: PointerEvent) => this.onPointerDown(e);
    const move = (e: PointerEvent) => this.onPointerMove(e);
    const up = (e: PointerEvent) => this.onPointerUp(e);
    const wheel = (e: WheelEvent) => this.onWheel(e);
    const ctx = (e: Event) => e.preventDefault();
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', wheel, opt);
    c.addEventListener('contextmenu', ctx);
    c.addEventListener('dblclick', () => {
      if (this.orbitEnabled && this.options.doubleClickReset) this.resetCamera(true);
    });
    // iOS Safari: stop the native pinch gesture from zooming the page
    const gs = (e: Event) => e.preventDefault();
    for (const n of ['gesturestart', 'gesturechange', 'gestureend']) c.addEventListener(n, gs as EventListener, opt);
    const kd = (e: KeyboardEvent) => this.onKey(e, true);
    const ku = (e: KeyboardEvent) => this.onKey(e, false);
    const target: EventTarget | null = this.options.keyboard === 'window' ? window : this.options.keyboard === 'focus' ? this.container : null;
    if (target) {
      target.addEventListener('keydown', kd as EventListener);
      target.addEventListener('keyup', ku as EventListener);
      const blur = () => this.keys.clear();
      window.addEventListener('blur', blur);
      this.cleanup.push(() => {
        target.removeEventListener('keydown', kd as EventListener);
        target.removeEventListener('keyup', ku as EventListener);
        window.removeEventListener('blur', blur);
      });
    }
    c.addEventListener('pointerdown', () => this.container.focus({ preventScroll: true }));
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.orbitEnabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers have no active pointer to capture */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button, shift: e.shiftKey });
    this.vel.yaw = this.vel.pitch = 0;
    this.beginGesture();
    e.preventDefault();

    // double tap (touch) reset
    if (e.pointerType !== 'mouse' && this.options.doubleClickReset && this.pointers.size === 1) {
      const now = performance.now();
      if (now - this.lastTapT < 300 && Math.hypot(e.clientX - this.lastTapX, e.clientY - this.lastTapY) < 24) {
        this.resetCamera(true);
        this.lastTapT = 0;
      } else {
        this.lastTapT = now;
        this.lastTapX = e.clientX;
        this.lastTapY = e.clientY;
      }
    }
  }

  private beginGesture(): void {
    const pts = [...this.pointers.values()];
    if (pts.length >= 2) {
      const [a, b] = pts;
      this.gesture = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    } else this.gesture = null;
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.orbitEnabled) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    e.preventDefault();

    if (this.pointers.size >= 2 && this.gesture) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const r = this.canvas.getBoundingClientRect();
      if (this.gesture.dist > 1 && dist > 1) {
        this.cameraCtl.zoomBy(dist / this.gesture.dist, (mx - r.left - r.width / 2) / r.height, (my - r.top - r.height / 2) / r.height);
      }
      this.cameraCtl.pan((mx - this.gesture.mx) / r.height, (my - this.gesture.my) / r.height);
      this.gesture = { dist, mx, my };
      this.emitUser();
      return;
    }

    const panMode = p.type === 'mouse' && (p.button === 2 || p.button === 1 || p.shift || e.shiftKey || (e.buttons & 6) !== 0);
    if (panMode) {
      const r = this.canvas.getBoundingClientRect();
      this.cameraCtl.pan(dx / r.height, dy / r.height);
    } else {
      const k = this.options.rotateSpeed;
      const dYaw = YAW_PER_PX_SIGN * dx * k;
      const dPitch = -dy * k; // dragging down moves the camera up (more top-down), like OrbitControls
      this.cameraCtl.orbit(dYaw, dPitch);
      const now = performance.now();
      const dtm = Math.max(1, now - this.lastMoveT) / 1000;
      this.vel.yaw = dYaw / dtm;
      this.vel.pitch = dPitch / dtm;
      this.lastMoveT = now;
    }
    this.emitUser();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.beginGesture();
    if (this.pointers.size === 0 && (!this.options.inertia || performance.now() - this.lastMoveT > 80)) this.vel.yaw = this.vel.pitch = 0;
  }

  private applyInertia(dt: number): void {
    if (!this.options.inertia || this.pointers.size > 0) return;
    if (Math.abs(this.vel.yaw) < 1 && Math.abs(this.vel.pitch) < 1) return;
    this.cameraCtl.orbit(this.vel.yaw * dt, this.vel.pitch * dt);
    const decay = Math.exp(-dt * 4);
    this.vel.yaw *= decay;
    this.vel.pitch *= decay;
    this.emitUser();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.orbitEnabled) return;
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const k = e.ctrlKey ? 0.01 : 0.0015; // ctrl+wheel == trackpad pinch
    const factor = Math.exp(-e.deltaY * scale * k);
    const r = this.canvas.getBoundingClientRect();
    this.cameraCtl.zoomBy(factor, (e.clientX - r.left - r.width / 2) / r.height, (e.clientY - r.top - r.height / 2) / r.height);
    this.emitUser();
  }

  private static ROT_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'];

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.orbitEnabled) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    this.shiftHeld = e.shiftKey;
    const code = e.code || e.key;
    if (down && code === 'Home') {
      this.resetCamera(true);
      e.preventDefault();
      return;
    }
    if (!PonderViewer.ROT_KEYS.includes(code)) return;
    if (down) this.keys.add(code);
    else this.keys.delete(code);
    e.preventDefault();
  }

  private applyKeys(dt: number): void {
    if (!this.keys.size || !this.orbitEnabled) return;
    const speed = this.shiftHeld ? 25 : 90; // deg/s; ArrowRight = drag right = positive user yaw
    let dYaw = 0;
    let dPitch = 0;
    if (this.keys.has('ArrowLeft')) dYaw -= speed * dt;
    if (this.keys.has('ArrowRight')) dYaw += speed * dt;
    if (this.keys.has('ArrowUp')) dPitch += (this.shiftHeld ? 20 : 60) * dt;
    if (this.keys.has('ArrowDown')) dPitch -= (this.shiftHeld ? 20 : 60) * dt;
    if (dYaw || dPitch) this.cameraCtl.orbit(dYaw, dPitch);
    let z = 1;
    if (this.keys.has('Equal') || this.keys.has('NumpadAdd')) z *= Math.exp(1.2 * dt);
    if (this.keys.has('Minus') || this.keys.has('NumpadSubtract')) z *= Math.exp(-1.2 * dt);
    if (z !== 1) this.cameraCtl.zoomBy(z);
    this.emitUser();
  }
}
