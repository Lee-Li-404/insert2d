import * as THREE from "three";
import gsap from "gsap";
import { Text } from "troika-three-text";
import { add } from "three/tsl";

// === Scene ===
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
camera.position.z = 1;

scene.add(new THREE.AmbientLight(0xffffff, 10));

const renderer = new THREE.WebGLRenderer({ antialias: true });
document.body.style.margin = 0;
document.body.appendChild(renderer.domElement);
renderer.outputColorSpace = THREE.SRGBColorSpace;

function resize() {
  const aspect = window.innerWidth / window.innerHeight;
  const zoom = 1;
  camera.left = -zoom * aspect;
  camera.right = zoom * aspect;
  camera.top = zoom;
  camera.bottom = -zoom;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);
resize();

// === Globals (HEX-ONLY) ===
const BALL_RADIUS = 0.015;
const HEX_RADIUS = 0.2; // 六边形半径（与 shader/碰撞一致）
const MAX_LIGHTS = 20;

const center = new THREE.Vector3(0, 0, 0);
const balls = []; // { mesh, color, vel, state }
const keywordToBall = new Map(); // kw -> ball（这里用于示范重复关键词的反馈）

// 力学拨杆（后面你可以接事件去调）
let K_CENTER = 0.28; // 向心吸引强度
let NOISE_MAG = 0.35; // 随机扰动强度
const MAX_SPEED = 0.5;
const MIN_SPEED = 0.05;

let idleFactor = 0.5;
let useRMS = false;

// 黄金角分布（入场角度更均匀）
let goldenIdx = 0;
const GOLDEN_ANGLE = 2.3999632297; // ≈137.5°

// === Helpers ===
function hashColorFromString() {
  return new THREE.Color(Math.random(), Math.random(), Math.random());
}

spawnKeywordBall("");

// === Hex geometry & shader ===
function buildHexShape(radius) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = Math.cos(a) * radius;
    const y = Math.sin(a) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

const hexShape = buildHexShape(HEX_RADIUS);
const hexGeo = new THREE.ShapeGeometry(hexShape);

// 新增两个 uniform
const glassUniforms = {
  uLightCount: { value: 0 },
  uLightPos: {
    value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector2()),
  },
  uLightColor: {
    value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Color()),
  },
  uRadiusWorld: { value: 0.5 },
  uIntensity: { value: 0.75 },
  uGrainScale: { value: 120.0 },
  uGrainAmount: { value: 0.015 },
  uAlpha: { value: 0.72 },
  uHexApothem: { value: HEX_RADIUS * 0.8660254037844386 }, // ★ 新增：六边形内切半径
  uHexFeather: { value: 0.006 }, // ★ 新增：边缘羽化宽度（世界单位）
};

// 扇贝圆参数（规则、平均）
Object.assign(glassUniforms, {
  uBaseRadius: { value: HEX_RADIUS }, // 基准半径 R0
  uFeather: { value: 0.006 }, // 形状边缘羽化（世界单位）
  uAmpFrac: { value: 0.14 }, // 扇贝振幅比例 0~0.3
  uK: { value: 3 }, // 波峰数（建议 6~10）
  uPhase: { value: 0.0 }, // 相位（可做慢速旋转）
});

// 描边参数（就在 bodyMesh 的同一 shader 里画）
Object.assign(glassUniforms, {
  uEdgeWidth: { value: 0.014 }, // 描边厚度（世界单位，沿形状内侧）
  uEdgeFeather: { value: 0.006 }, // 描边软化
  uEdgeColor: { value: new THREE.Color(0xffffff) }, // 描边颜色
  uEdgeAlpha: { value: 0.6 }, // 描边不透明度
});

// 不再用六边形那两个
delete glassUniforms.uHexApothem;
delete glassUniforms.uHexFeather;

const glassMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: glassUniforms,
  vertexShader: /* glsl */ `
    varying vec2 vWorld;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xy;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
varying vec2 vWorld;
uniform int   uLightCount;
uniform vec2  uLightPos[${MAX_LIGHTS}];
uniform vec3  uLightColor[${MAX_LIGHTS}];
uniform float uRadiusWorld;
uniform float uIntensity;
uniform float uGrainScale;
uniform float uGrainAmount;
uniform float uAlpha;

// 规则扇贝圆参数
uniform float uBaseRadius; // R0
uniform float uFeather;    // 形状羽化宽度（世界单位）
uniform float uAmpFrac;    // 振幅比例
uniform float uK;          // 波峰数
uniform float uPhase;      // 相位（可用于缓慢旋转）

// 内描边（同一个 mesh 上画）
uniform float uEdgeWidth;
uniform float uEdgeFeather;
uniform vec3  uEdgeColor;
uniform float uEdgeAlpha;

float hash(vec2 p){return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  float a=hash(i), b=hash(i+vec2(1.,0.));
  float c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
  vec2 u=f*f*(3.-2.*f);
  return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;
}

void main(){
  // 极坐标
  float r  = length(vWorld);
  float th = atan(vWorld.y, vWorld.x);

  // 规则“扇贝圆”半径：R(θ)=R0*(1 + a·cos(kθ+φ))
  float Rth = uBaseRadius * (1.0 + uAmpFrac * cos(uK * th + uPhase));

  // 距离带符号：外部为正，内部为负
  float d = r - Rth;

  // ★★ 硬裁剪：形状外面直接丢弃像素（完全不写颜色/alpha）
  if (d > uFeather) { discard; }

  // 软掩膜：inside→1, edge→平滑过渡
  // 这条写法方向明确：r < Rth - feather 时≈1；r > Rth + feather 时≈0
  float mask = smoothstep(Rth + uFeather, Rth - uFeather, r);

  // === 发光只在形状内部 ===
  vec3 accum = vec3(0.0);
  float sumFall = 0.0;
  for (int i=0; i<${MAX_LIGHTS}; i++){
    if (i>=uLightCount) break;
    float dist = length(vWorld - uLightPos[i]);
    float g = (noise(vWorld * uGrainScale + float(i)*13.37) - 0.5) * uGrainAmount;
    dist += g;

    float fall = smoothstep(uRadiusWorld, 0.0, dist);
    fall = pow(fall, 1.35);

    fall *= mask; // ★ 仅内部有效
    accum += uLightColor[i] * fall;
    sumFall += fall;
  }

  // 内部颜色/透明度（乘 mask，进一步确保外面为 0）
  vec3  innerColor = accum * uIntensity;
  float innerAlpha = mask * clamp(sumFall, 0.0, 1.0) * uAlpha;

  // === 内描边：沿内侧，厚度 uEdgeWidth ===
  float t = -d; // 内侧距离（>0 表示在内部）
  float edgeBand = smoothstep(0.0, uEdgeFeather, t)
                 * (1.0 - smoothstep(uEdgeWidth, uEdgeWidth + uEdgeFeather, t));
  edgeBand *= mask; // 只在内部

  vec3  edgeCol = uEdgeColor * edgeBand;
  float edgeAlp = uEdgeAlpha * edgeBand;

  // 合成
  vec3  finalColor = innerColor + edgeCol;
  float finalAlpha = max(innerAlpha, edgeAlp);

  gl_FragColor = vec4(finalColor, finalAlpha);
}


  `,
});

glassUniforms.uEdgeWidth.value = 0.0; // 厚度为 0
glassUniforms.uEdgeAlpha.value = 0.0; // 完全透明

const backMat = new THREE.MeshBasicMaterial({ color: 0x090909 });

const bodyGeo = new THREE.CircleGeometry(0.6, 256);
let bodyMesh = null,
  backMesh = null;

function ensureBodyMeshes() {
  if (!bodyMesh) bodyMesh = new THREE.Mesh(bodyGeo, glassMat);
  if (!backMesh) {
    backMesh = new THREE.Mesh(bodyGeo, backMat);
    backMesh.position.z = -0.01;
  }
}
ensureBodyMeshes();
scene.add(bodyMesh);
// scene.add(backMesh);

// === 扇贝“顶点/边”数量按萤火虫数自动更新 ===
const MIN_LOBES = 2; // 最少的“顶点/边”数（你要更规则就 ≥6）
const MAX_LOBES = 24; // 上限，防止过密
let lastLobeK = glassUniforms.uK.value;

// 让幅度随 k 略衰减：k 多时波峰不会显得过炸
function ampCompensationForK(k, baseAmp = 0.14, refK = 8, gamma = 0.6) {
  // 经验：a(k) = baseAmp * (refK / k)^gamma
  return baseAmp * Math.pow(refK / Math.max(1, k), gamma);
}

function updateBodyLobesByBallCount() {
  const count = Math.max(1, balls.length); // 或者用 contributors.length
  const targetK = Math.max(MIN_LOBES, Math.min(MAX_LOBES, MIN_LOBES + count));

  if (targetK !== lastLobeK) {
    // 平滑过渡 k / 幅度，避免“弹跳”
    gsap.to(glassUniforms.uK, {
      value: targetK,
      duration: 0.35,
      ease: "power2.inOut",
    });
    gsap.to(glassUniforms.uAmpFrac, {
      value: ampCompensationForK(
        targetK,
        /*baseAmp=*/ 0.14,
        /*refK=*/ 8,
        /*gamma=*/ 0.6
      ),
      duration: 0.35,
      ease: "power2.inOut",
    });
    lastLobeK = targetK;
  }
}

// === Hex collision (point-in-hex) ===
const hexVerts = [];
for (let i = 0; i < 6; i++) {
  const a = (i / 6) * Math.PI * 2;
  hexVerts.push(
    new THREE.Vector2(Math.cos(a) * HEX_RADIUS, Math.sin(a) * HEX_RADIUS)
  );
}
function pointInConvexPolygon(p) {
  for (let i = 0; i < 6; i++) {
    const a = hexVerts[i],
      b = hexVerts[(i + 1) % 6];
    const ab = new THREE.Vector2(b.x - a.x, b.y - a.y);
    const ap = new THREE.Vector2(p.x - a.x, p.y - a.y);
    if (ab.x * ap.y - ab.y * ap.x < 0) return false;
  }
  return true;
}

function radiusAtWavyJS(theta) {
  const R0 = glassUniforms.uBaseRadius.value;
  const a = glassUniforms.uAmpFrac.value;
  const k = glassUniforms.uK.value;
  const ph = glassUniforms.uPhase.value;
  return R0 * (1 + a * Math.cos(k * theta + ph));
}
function pointInsideWavy(p) {
  const r = Math.hypot(p.x, p.y);
  const th = Math.atan2(p.y, p.x);
  return r <= radiusAtWavyJS(th);
}

function nextPow2(x) {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(1, x))));
}

// 将“希望的像素高度”转换成世界高度（正交相机）
function pixelsToWorldHeight(px) {
  const viewH = renderer.domElement.height; // 真实像素高
  const worldH = camera.top - camera.bottom; // 世界高
  return (px / viewH) * worldH;
}

let breatheTl = null;

function breatheHex({
  scaleUp = 1.03, // 放大倍率
  oneBeat = 0.18, // 单次起伏时长
  repeats = 2, // 呼吸次数
  ease = "power2.inOut",
  edgeFollowsScale = false, // =true 时描边厚度也随规模变
} = {}) {
  // 停掉上一次
  if (breatheTl) {
    breatheTl.kill();
    breatheTl = null;
  }

  // 记录当前基线，避免多次调用累计漂移
  const baseR = glassUniforms.uBaseRadius.value;
  const baseFall = glassUniforms.uRadiusWorld.value;
  const baseEW = glassUniforms.uEdgeWidth?.value ?? 0.014;
  const baseEF = glassUniforms.uEdgeFeather?.value ?? 0.006;

  const proxy = { s: 1.0 };

  breatheTl = gsap.timeline({
    defaults: { duration: oneBeat, ease },
    onUpdate: () => {
      const s = proxy.s;
      // ★ 直接改“形状半径”，让扇贝圆本体呼吸
      glassUniforms.uBaseRadius.value = baseR * s;
      // ★ 同步光衰减半径，保持亮斑尺度一致
      glassUniforms.uRadiusWorld.value = baseFall * s;

      // 可选：描边厚度也随体积变化
      if (edgeFollowsScale) {
        if (glassUniforms.uEdgeWidth)
          glassUniforms.uEdgeWidth.value = baseEW * s;
        if (glassUniforms.uEdgeFeather)
          glassUniforms.uEdgeFeather.value = baseEF * s;
      }
    },
    onComplete: () => {
      // 结束时精确回到基线，避免浮点误差
      glassUniforms.uBaseRadius.value = baseR;
      glassUniforms.uRadiusWorld.value = baseFall;
      if (edgeFollowsScale) {
        if (glassUniforms.uEdgeWidth) glassUniforms.uEdgeWidth.value = baseEW;
        if (glassUniforms.uEdgeFeather)
          glassUniforms.uEdgeFeather.value = baseEF;
      }
    },
  });

  // 一个“呼吸”= 放大 -> 缩回
  for (let i = 0; i < repeats; i++) {
    breatheTl.to(proxy, { s: scaleUp }).to(proxy, { s: 1.0 });
  }
}

// 高清文字 Sprite：传入目标“屏幕像素高度”
function makeTextSprite(text, color = "#ffffff", targetPixelHeight = 48) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5); // 保守上限，防止超大纹理
  const pad = Math.round(16 * dpr);
  const fontPx = Math.round(targetPixelHeight * dpr * 2); // 再放大一档，给边缘留余量

  // 先测量文本宽度（按 DPR 放大）
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `${fontPx}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial`;
  const textW = Math.ceil(measure.measureText(text).width);

  // 画布尺寸用最近的 2 的幂（POT），以启用 mipmap
  const rawW = textW + pad * 2;
  const rawH = fontPx + pad * 2;
  const potW = nextPow2(rawW);
  const potH = nextPow2(rawH);

  const canvas = document.createElement("canvas");
  canvas.width = potW;
  canvas.height = potH;

  const ctx = canvas.getContext("2d");
  ctx.font = measure.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 可选：描边增强对比度（柔和外描边）
  ctx.lineWidth = Math.max(1, Math.round(fontPx * 0.12));
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.strokeText(text, potW / 2, potH / 2);

  ctx.fillStyle = color;
  ctx.fillText(text, potW / 2, potH / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true; // 现在是 POT，可以开 mipmap
  tex.minFilter = THREE.LinearMipmapLinearFilter; // 缩小时更清
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy?.() ?? 1;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  const sp = new THREE.Sprite(mat);
  sp.center.set(0.5, 0.5);
  sp.renderOrder = 2;

  // 让屏幕像素高度 ≈ targetPixelHeight
  const aspect = potW / potH;
  const worldH = pixelsToWorldHeight(targetPixelHeight);
  sp.scale.set(worldH * aspect, worldH, 1);
  return sp;
}

// 文字与小球“同点生成”：文字缩小→小球放大→小球再进入 HEX 内部
function spawnKeywordBall(kw) {
  const key = kw.toLowerCase();
  if (keywordToBall.has(key)) {
    const ball = keywordToBall.get(key);
    gsap.fromTo(
      ball.mesh.scale,
      { x: 1, y: 1 },
      {
        x: 1.15,
        y: 1.15,
        duration: 0.18,
        yoyo: true,
        repeat: 1,
        ease: "power2.inOut",
      }
    );
    return;
  }

  const color = hashColorFromString(kw);

  const angle = goldenIdx++ * GOLDEN_ANGLE;
  const rEnter = HEX_RADIUS * 1.9;
  const rSettle = HEX_RADIUS * 0.8;

  const x0 = Math.cos(angle) * rEnter,
    y0 = Math.sin(angle) * rEnter;
  const xI = Math.cos(angle) * rSettle,
    yI = Math.sin(angle) * rSettle;

  // 文字与小球同点生成
  // 使用
  const textSprite = makeTextSprite(kw, `#${color.getHexString()}`, 38); // 48px 高
  textSprite.position.set(x0, y0, 0.01);
  scene.add(textSprite);

  const matBall = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
  });
  const meshBall = new THREE.Mesh(
    new THREE.CircleGeometry(BALL_RADIUS, 32),
    matBall
  );
  meshBall.position.set(x0, y0, 0.0);
  meshBall.scale.setScalar(0.0);
  scene.add(meshBall);

  const ball = {
    mesh: meshBall,
    color,
    vel: new THREE.Vector2(-Math.sin(angle) * 0.08, Math.cos(angle) * 0.08),
    state: "OUTSIDE",
  };

  // 时间线
  const tl = gsap.timeline();

  // A 阶段
  tl.to(textSprite.scale, { x: 0, y: 0, duration: 0.8, ease: "power2.inOut" })
    .to(
      textSprite.material,
      { opacity: 0, duration: 0.8, ease: "power2.inOut" },
      0
    )
    .fromTo(
      meshBall.scale,
      { x: 0, y: 0, z: 0 },
      {
        x: 1,
        y: 1,
        z: 1,
        duration: 0.8,
        ease: "back.out(1.5)",
        immediateRender: false,
      },
      0
    )
    .addLabel("A_end"); // 记录 A 阶段结束点

  // B 阶段：在 A_end 提前 0.2s
  tl.to(
    meshBall.position,
    {
      x: xI,
      y: yI,
      duration: 0.8,
      ease: "power2.inOut",
      onComplete: () => {
        balls.push(ball);
        keywordToBall.set(key, ball);
        scene.remove(textSprite);
        textSprite.material.map?.dispose?.();
        textSprite.material.dispose();
        textSprite.geometry?.dispose?.();

        // ★ 新增：按当前球的数量更新“顶点/边”数
        updateBodyLobesByBallCount();
      },
    },
    "A_end-=0.2"
  );
}

// === Animate (HEX-ONLY) ===
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  if (useRMS) {
    const rawRms = measureRMS();
    // 门限&归一化
    const norm = Math.max(0, rawRms - RMS_NOISE_FLOOR) / RMS_FULL_SCALE;
    const target = Math.min(1, norm);

    // 指数平滑（时间常数跟随 dt）
    const smoothAlpha = 1 - Math.exp(-6 * dt); // 6 可调，越大响应越快
    rmsSmooth += (target - rmsSmooth) * smoothAlpha;

    // 把平滑 RMS 映射成缩放系数：s ∈ [1, 1 + RMS_MAX_GAIN]
    const s = 1 + rmsSmooth * RMS_MAX_GAIN;

    // 同步半径与光衰半径，等价“呼吸”
    glassUniforms.uBaseRadius.value = BASE_R0 * s;
    glassUniforms.uRadiusWorld.value = BASE_FALLOFF * s;
  }

  const contributors = balls.slice(0, MAX_LIGHTS); // 仍用于光源、与形状无关

  for (const b of balls) {
    const m = b.mesh;

    // ★ 新判定：规则扇贝圆
    const pos2 = new THREE.Vector2(m.position.x, m.position.y);
    const inside = pointInsideWavy(pos2);

    if (b.state === "OUTSIDE" && inside) b.state = "INSIDE";
    else if (b.state === "INSIDE" && !inside) b.state = "ESCAPING";
    else if (b.state === "ESCAPING" && inside) b.state = "INSIDE";

    // 力学同原先
    const acc = new THREE.Vector2();
    if (b.state === "OUTSIDE") {
      acc
        .copy(center)
        .sub(m.position)
        .normalize()
        .multiplyScalar(2.5)
        .multiplyScalar(idleFactor);
    } else if (b.state === "INSIDE") {
      const baseAngle = Math.atan2(b.vel.y, b.vel.x);
      const randOffset = (Math.random() - 0.5) * Math.PI * 1.6;
      const targetAngle = baseAngle + randOffset;
      acc
        .set(Math.cos(targetAngle), Math.sin(targetAngle))
        .multiplyScalar(0.45)
        .multiplyScalar(idleFactor);
    } else if (b.state === "ESCAPING") {
      acc
        .copy(center)
        .sub(m.position)
        .normalize()
        .multiplyScalar(0.9)
        .multiplyScalar(idleFactor);
    }

    b.vel.add(acc.multiplyScalar(dt));
    b.vel.multiplyScalar(0.995);
    const speed = b.vel.length();
    if (speed > MAX_SPEED) b.vel.multiplyScalar(MAX_SPEED / speed);
    if (speed < MIN_SPEED) {
      const ang = Math.random() * Math.PI * 2;
      b.vel.set(Math.cos(ang), Math.sin(ang)).multiplyScalar(MIN_SPEED);
    }

    m.position.x += b.vel.x * dt;
    m.position.y += b.vel.y * dt;
  }

  // 喂给 Shader（保持不变）
  const n = contributors.length;
  glassUniforms.uLightCount.value = n;
  glassUniforms.uIntensity.value = 0.75 / Math.pow(Math.max(1, n), 0.3);
  for (let i = 0; i < n; i++) {
    const b = contributors[i];
    glassUniforms.uLightPos.value[i].set(b.mesh.position.x, b.mesh.position.y);
    glassUniforms.uLightColor.value[i].copy(b.color);
  }

  renderer.render(scene, camera);
}

animate();

let l = ["北京", "周末", "爱运动", "小吃", "四大名著"];
let idx = 0;
// === Keyboard: press 'A' to add a hardcoded keyword ball ===
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "a") {
    spawnKeywordBall(l[idx]);
    idx = (idx + 1) % l.length;
  }
  if (e.key.toLowerCase() === "b") {
    breatheHex(); // 也可传参定制：breatheHex({ scaleUp: 1.08, repeats: 3 })
  }
});

let isRefresh = false;
let addedKW = [];
const textWS = new WebSocket("ws://localhost:8000/ws/text");
textWS.onopen = () => textWS.send("ping"); // 可选
textWS.onmessage = (ev) => {
  const data = JSON.parse(ev.data); // { event, text, keywords, timestamp }
  const list = Array.isArray(data.keywords) ? data.keywords : [];
  for (const raw of list) {
    const kw = (raw || "").trim();
    if (!kw || kw === "豆包" || addedKW.includes(kw)) continue;
    spawnKeywordBall(kw);
  }

  for (let elem of list) {
    if (!addedKW.includes(elem)) {
      addedKW.push(elem);
    }
  }
};

// 创建用于播放音频的 AudioContext
const globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)({
  sampleRate: 24000,
});
const analyserNode = globalAudioCtx.createAnalyser();
analyserNode.fftSize = 256;
const audioDataArray = new Float32Array(analyserNode.fftSize);

const audioCtx = new AudioContext({ sampleRate: 24000 });
const playQueue = []; // 播放队列，避免卡顿

// 创建 WebSocket 接收后端音频数据
const audioSocket = new WebSocket("ws://localhost:8000/ws/tts");
audioSocket.binaryType = "arraybuffer";

audioSocket.onmessage = async (event) => {
  const arrayBuffer = event.data;

  // 检查音频数据基本状态
  console.log("📥 收到音频包:", arrayBuffer.byteLength);
  const float32Data = new Float32Array(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  // console.log("原始前10字节:", bytes.slice(0, 10));
  // console.log("Float32前5个:", float32Data.slice(0, 5));

  // ✅ 确保音频值范围合理
  const max = Math.max(...float32Data);
  const min = Math.min(...float32Data);

  // ✅ 创建 AudioBuffer
  const audioBuffer = globalAudioCtx.createBuffer(
    1, // 单声道
    float32Data.length,
    globalAudioCtx.sampleRate
  );
  audioBuffer.copyToChannel(float32Data, 0);

  // ✅ 入队并播放
  playQueue.push(audioBuffer);
  playFromQueue();
};

// === RMS 驱动参数（可按需微调） ===
const BASE_R0 = glassUniforms.uBaseRadius.value;
const BASE_FALLOFF = glassUniforms.uRadiusWorld.value;

// 为了显示更平滑，做指数平滑
let rmsSmooth = 0;
// 噪声门限（静音/底噪抑制）
const RMS_NOISE_FLOOR = 0.015; // 抑制底噪
const RMS_FULL_SCALE = 0.12; // 中等灵敏度
const RMS_MAX_GAIN = 0.25; // 最大放大 25%

// 读取 analyserNode 的时域数据并计算 RMS
function measureRMS() {
  analyserNode.getFloatTimeDomainData(audioDataArray);
  let sum = 0;
  for (let i = 0; i < audioDataArray.length; i++) {
    const v = audioDataArray[i];
    sum += v * v;
  }
  return Math.sqrt(sum / audioDataArray.length);
}

document.body.addEventListener(
  "click",
  () => {
    if (audioCtx.state !== "running") {
      audioCtx.resume();
      console.log("🔊 audioCtx resumed");
    }
    if (globalAudioCtx.state !== "running") {
      globalAudioCtx.resume();
      console.log("🔊 globalAudioCtx resumed");
    }
  },
  { once: true }
);

let isPlaying = false;
let nextPlayTime = globalAudioCtx.currentTime;

function playFromQueue() {
  if (isPlaying || playQueue.length === 0) return;

  const buffer = playQueue.shift();
  const source = globalAudioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(analyserNode);
  analyserNode.connect(globalAudioCtx.destination);

  // 避免排队时间落后于当前时间
  const safetyLead = 0.02;
  nextPlayTime = Math.max(
    nextPlayTime,
    globalAudioCtx.currentTime + safetyLead
  );

  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;

  isPlaying = true;

  source.onended = () => {
    isPlaying = false;
    // 如果队列里还有，继续下一段；否则停掉 VAD
    if (playQueue.length === 0) {
      // stopPlaybackVAD();
    }
    playFromQueue();
  };
}

let currentEventId = null;

async function pollBackendStatus() {
  try {
    const response = await fetch("http://localhost:8000/status");

    const data = await response.json();
    let eventId = data.event_id;

    // ✅ 自动修复：如果播放结束但后端还没更新 event_id
    const audioIdle = playQueue.length === 0 && !isPlaying;
    if (eventId === 359 && audioIdle) {
      console.log("✅ 音频播放完毕，自动切换为 event_id 999");
      eventId = 999;
    }

    if (eventId !== currentEventId) {
      currentEventId = eventId;
      handleEvent(eventId, data.text);
    }
  } catch (error) {
    console.error("获取后端状态失败:", error);
  }
}

function handleEvent(eventId, text) {
  console.log("切换状态:", eventId, "识别文本:", text);
  if (eventId == 999) {
    idleFactor = 0.14;
    useRMS = false;
  } else if (eventId == 352 || eventId == 359) {
    idleFactor = 1.0;
    useRMS = true;
  }
}

// 每 100ms 轮询一次
setInterval(pollBackendStatus, 100);

const API_BASE = "http://localhost:8000";
const BLANK_PAGE = "/thankyou.html"; // 你想跳去的页面

(async () => {
  try {
    const res = await fetch(`${API_BASE}/availability`, { cache: "no-store" });
    const data = await res.json();

    console.log(data); // ✅ 打印解析后的结果

    if (data.occupied) {
      isRefresh = true;
      location.replace(BLANK_PAGE);
      return;
    }
  } catch (err) {
    console.error("检查占用状态失败", err);
  }

  // 只有等上面的 await 完成后，才会执行这里
  console.log("WebSocket 建立逻辑在这里跑");
})();

//麦克风输入
let micStream;
let socket = new WebSocket("ws://localhost:8000/ws/audio");
socket.binaryType = "arraybuffer";

// Float32 → Int16 转换函数
function convertFloat32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(int16Array.buffer);
}

socket.onopen = async () => {
  console.log("🎤 WebSocket连接建立，准备推送音频数据");

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioCtx = new AudioContext({ sampleRate: 24000 }); // 确保采样率一致
  const source = audioCtx.createMediaStreamSource(micStream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);

  source.connect(processor);
  processor.connect(audioCtx.destination);

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0); // Float32Array
    const pcmBytes = convertFloat32ToInt16(input); // ✅ 转换为 Int16 PCM

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(pcmBytes); // ✅ 发送 Int16 PCM 数据
    }
  };
};

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

startBtn.onclick = () => {
  isRefresh = true;
  fetch("http://localhost:8000/start", {
    method: "POST",
  }).catch((err) => console.error("❌ Start error:", err));

  // 🌟 一秒后刷新页面
  setTimeout(() => {
    location.reload();
  }, 2000);
};

stopBtn.onclick = async () => {
  try {
    const res = await fetch("http://localhost:8000/stop", {
      method: "POST",
    });
    const data = await res.json();
    console.log("🛑 Stop Response:", data);
  } catch (err) {
    console.error("❌ Stop error:", err);
  }

  // 🌟 一秒后刷新页面
  setTimeout(() => {
    location.reload();
  }, 1000);
};

setTimeout(() => {
  console.log("⏰ 页面已打开超过5分钟，自动停止");

  fetch("http://localhost:8000/stop", {
    method: "POST",
  })
    .then((res) => res.json())
    .then((data) => {
      console.log("🛑 自动 Stop Response:", data);
      window.location.href = "/thankyou.html"; // 或你的主页/提示页
    })
    .catch((err) => {
      console.error("❌ 自动 Stop 请求失败:", err);
      window.location.href = "/thankyou.html"; // 或你的主页/提示页
    });
}, 20 * 60 * 1000); // 60秒

window.addEventListener("unload", () => {
  if (!isRefresh) {
    fetch("http://localhost:8000/stop", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "close" }), // 可选
    });
  }
});
