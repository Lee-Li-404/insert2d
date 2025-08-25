import * as THREE from "three";
import gsap from "gsap";

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

// === Globals ===
const BALL_RADIUS = 0.015;

const center = new THREE.Vector3(0, 0, 0);
const balls = []; // { mesh, color, vel, state, containerMesh?, bounds? }

const HEX_RADIUS = 0.2;
let hexMesh = null;
let backMesh = null;

// 放在 Globals 附近，按需微调
const GATHER_BASE = 0.25; // 基础时长（每个对象的最短动画时间）
const GATHER_JITTER = 0.4; // 动画时长的随机抖动范围（最大可额外加 1 秒）
const GATHER_STAGGER = 0.3; // 索引之间的阶梯延迟（0.3 秒一个）
const GATHER_EXTRA_DELAY = 0.4; // 额外随机延迟（0~0.4 秒）
const POST_KICK_MIN = 0.35;
const POST_KICK_MAX = 0.75;
const EASES = ["power2.inOut", "power3.inOut", "sine.inOut", "circ.inOut"];

// === Keyword registry ===
const seenKeywords = new Set();

// 稳定哈希上色（同词同色）
function hashColorFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 131 + str.charCodeAt(i)) >>> 0;
  const hue = (h % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.75, 0.55);
}

// 把关键词画成一张 Sprite（正交相机下简洁可控）
function makeTextSprite(text, color = "#ffffff") {
  const canvas = document.createElement("canvas");
  const pad = 12,
    fz = 50; // 字体尺寸越大，收缩时更清晰
  const ctx = canvas.getContext("2d");
  ctx.font = `${fz}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial`;
  const tw = Math.ceil(ctx.measureText(text).width);
  canvas.width = tw + pad * 2;
  canvas.height = fz + pad * 2;

  const ctx2 = canvas.getContext("2d");
  ctx2.font = ctx.font;
  ctx2.fillStyle = color;
  ctx2.textBaseline = "top";
  ctx2.fillText(text, pad, pad);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sp = new THREE.Sprite(mat);

  // 像素→世界的缩放；正交相机下用常数即可（可按观感微调）
  const scale = 0.0043;
  sp.scale.set(canvas.width * scale, canvas.height * scale, 1);
  return sp;
}

function pickNextShape() {
  // 过滤掉当前形状
  const pool = CONTAINER_SHAPES.filter((s) => s !== CONTAINER_TYPE);
  // 随机选一个
  CONTAINER_TYPE = pool[Math.floor(Math.random() * pool.length)];
  console.log("Switched to", CONTAINER_TYPE);
}

// === Build hex geometry (for later) ===
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

// HEX-ONLY: 初始化就显示六边形容器
ensureHexMeshes();
if (!scene.children.includes(hexMesh)) scene.add(hexMesh);
if (!scene.children.includes(backMesh)) scene.add(backMesh);

// === Hex collision data ===
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

// === Glass shader (shared) ===
const MAX_LIGHTS = 20;
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
};

const glassMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: glassUniforms,
  vertexShader: `
    varying vec2 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xy;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    varying vec2 vWorld;
    uniform int   uLightCount;
    uniform vec2  uLightPos[${MAX_LIGHTS}];
    uniform vec3  uLightColor[${MAX_LIGHTS}];
    uniform float uRadiusWorld;
    uniform float uIntensity;
    uniform float uGrainScale;
    uniform float uGrainAmount;
    uniform float uAlpha;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i=floor(p), f=fract(p);
      float a=hash(i);
      float b=hash(i+vec2(1.,0.));
      float c=hash(i+vec2(0.,1.));
      float d=hash(i+vec2(1.,1.));
      vec2 u=f*f*(3.-2.*f);
      return mix(a,b,u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
    }

    void main() {
      vec3 accum = vec3(0.0);
      float sumFall = 0.0;

      for(int i=0;i<${MAX_LIGHTS};i++){
        if(i>=uLightCount) break;
        float dist = length(vWorld - uLightPos[i]);
        float g = (noise(vWorld * uGrainScale + float(i)*13.37) - 0.5) * uGrainAmount;
        dist += g;
        float fall = smoothstep(uRadiusWorld, 0.0, dist);
        fall = pow(fall, 1.35);
        accum += uLightColor[i] * fall;
        sumFall += fall;
      }

      vec3 color = accum * uIntensity;
      float alpha = clamp(sumFall, 0.0, 1.0) * uAlpha;
      gl_FragColor = vec4(color, alpha);
    }
  `,
});

// 背板材质
const backMat = new THREE.MeshBasicMaterial({ color: 0x090909 });

// === 六边形形态：组装 hex + 背板 ===
function ensureHexMeshes() {
  if (!hexMesh) {
    hexMesh = new THREE.Mesh(hexGeo, glassMat);
  }
  if (!backMesh) {
    backMesh = new THREE.Mesh(hexGeo, backMat);
    backMesh.position.z = -0.01;
  }
}

// === Animate ===
const clock = new THREE.Clock();
const tmpV3 = new THREE.Vector3();
const tmpV2 = new THREE.Vector2();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  for (const b of balls) {
    const m = b.mesh;
    let inside = false;

    // 六边形判定（世界坐标）
    const pos2 = new THREE.Vector2(m.position.x, m.position.y);
    inside = pointInConvexPolygon(pos2);

    // 状态机
    if (b.state === "OUTSIDE" && inside) b.state = "INSIDE";
    else if (b.state === "INSIDE" && !inside) b.state = "ESCAPING";
    else if (b.state === "ESCAPING" && inside) b.state = "INSIDE";

    // 力/加速度
    const acc = new THREE.Vector2();
    if (!exploded) {
      // 六边形：以中心吸引
      if (b.state === "OUTSIDE") {
        acc.copy(center).sub(m.position).normalize().multiplyScalar(2.5);
      } else if (b.state === "INSIDE") {
        let baseAngle = Math.atan2(b.vel.y, b.vel.x);
        let randOffset = (Math.random() - 0.5) * Math.PI * 1.6;
        let targetAngle = baseAngle + randOffset;
        acc
          .set(Math.cos(targetAngle), Math.sin(targetAngle))
          .multiplyScalar(0.45);
      } else if (b.state === "ESCAPING") {
        acc.copy(center).sub(m.position).normalize().multiplyScalar(0.9);
      }
    } else {
      // 方块：以各自方块中心吸引
      b.containerMesh.getWorldPosition(tmpV3);
      const cx = tmpV3.x,
        cy = tmpV3.y;

      if (b.state === "OUTSIDE") {
        acc
          .set(cx - m.position.x, cy - m.position.y)
          .normalize()
          .multiplyScalar(2.5);
      } else if (b.state === "INSIDE") {
        let baseAngle = Math.atan2(b.vel.y, b.vel.x);
        let randOffset = (Math.random() - 0.5) * Math.PI * 1.6;
        let targetAngle = baseAngle + randOffset;
        acc
          .set(Math.cos(targetAngle), Math.sin(targetAngle))
          .multiplyScalar(0.6);
      } else if (b.state === "ESCAPING") {
        acc
          .set(cx - m.position.x, cy - m.position.y)
          .normalize()
          .multiplyScalar(0.9);
      }

      // 同步球到其方块 shader（世界坐标）
      const mat = b.containerMesh.material;
      mat.uniforms.uLightPos.value[0].set(m.position.x, m.position.y);
      mat.uniforms.uLightColor.value[0].copy(b.color);
    }

    // 速度积分 & 阻尼/限速
    b.vel.add(acc.multiplyScalar(dt));
    b.vel.multiplyScalar(0.995);
    const speed = b.vel.length();
    if (speed > 0.5) b.vel.multiplyScalar(0.5 / speed);
    if (speed < 0.05) {
      const ang = Math.random() * Math.PI * 2;
      b.vel.set(Math.cos(ang), Math.sin(ang)).multiplyScalar(0.05);
    }

    m.position.x += b.vel.x * dt;
    m.position.y += b.vel.y * dt;
  }

  // 六边形形态：把在六边形内的球喂给统一 shader
  if (hexMesh) {
    const trapped = balls.filter((b) =>
      pointInConvexPolygon(
        new THREE.Vector2(b.mesh.position.x, b.mesh.position.y)
      )
    );
    const n = Math.min(trapped.length, MAX_LIGHTS);
    glassUniforms.uLightCount.value = n;
    glassUniforms.uIntensity.value = 0.75 / Math.pow(Math.max(1, n), 0.3);

    for (let i = 0; i < n; i++) {
      const b = trapped[i];
      glassUniforms.uLightPos.value[i].set(
        b.mesh.position.x,
        b.mesh.position.y
      );
      glassUniforms.uLightColor.value[i].copy(b.color);
    }
  }

  renderer.render(scene, camera);
}

animate();

//
//
//
//
//
//
//
//

let isRefresh = false;
// const caption = document.getElementById("caption");
const textWS = new WebSocket("ws://localhost:8000/ws/text");
textWS.onopen = () => textWS.send("ping"); // 可选
textWS.onmessage = (ev) => {
  const data = JSON.parse(ev.data); // { event, text, keywords, timestamp }
  console.log("文本:", data.text, "关键词:", data.keywords);
  // caption.innerHTML = highlightText(data.text, data.keywords || []);

  const list = Array.isArray(data.keywords) ? data.keywords : [];
  for (const raw of list) {
    const kw = (raw || "").trim();
    if (!kw || kw == "豆包") continue;
    const key = kw.toLowerCase();
    if (seenKeywords.has(key)) {
      // 已经有这个词：可选做个“呼吸”提示（不需要就忽略）
      // const i = balls.length - 1; // 或根据你的映射找到具体球
      continue;
    }
    seenKeywords.add(key);
    // spawnKeywordAsBallAtRing(kw);
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
      stopPlaybackVAD();
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
    if (eventId == 999) {
    } else if (eventId == 352) {
    }
  } catch (error) {
    console.error("获取后端状态失败:", error);
  }
}

function handleEvent(eventId, text) {
  console.log("切换状态:", eventId, "识别文本:", text);
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
}, 5 * 60 * 1000); // 60秒

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
