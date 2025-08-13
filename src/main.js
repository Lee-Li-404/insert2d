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
let exploded = true; // 反转：默认就是方块形态
let squareBlocks = []; // 每个小球对应的方块
const SQUARE_SIZE = 0.15; // 方块边长
const BALL_RADIUS = 0.015;

const center = new THREE.Vector3(0, 0, 0);
const balls = []; // { mesh, color, vel, state, containerMesh?, bounds? }

const HEX_RADIUS = 0.2;
let hexMesh = null;
let backMesh = null;

const NORMAL_RADIUS = 0.3;
const LARGER_RADIUS = 0.55;
let cur_radius = NORMAL_RADIUS; // 环半径（和 ringLayout 的半径一致）
let ringAngle = 0; // 当前全局相位
let ANGULAR_SPEED = 0.4; // 角速度（弧度/秒），可调

// 放在 Globals 附近，按需微调
const GATHER_BASE = 0.5; // 基础时长（每个对象的最短动画时间）
const GATHER_JITTER = 1.0; // 动画时长的随机抖动范围（最大可额外加 1 秒）
const GATHER_STAGGER = 0.3; // 索引之间的阶梯延迟（0.3 秒一个）
const GATHER_EXTRA_DELAY = 0.4; // 额外随机延迟（0~0.4 秒）
const POST_KICK_MIN = 0.35;
const POST_KICK_MAX = 0.75;
const EASES = ["power2.inOut", "power3.inOut", "sine.inOut", "circ.inOut"];

const CONTAINER_SHAPES = ["square", "circle", "triangle", "hex", "diamond"];
let CONTAINER_TYPE = "square"; // 初始形状

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

function makeContainerGeometry(type, size) {
  switch (type) {
    case "square":
      return new THREE.PlaneGeometry(size, size);
    case "circle":
      return new THREE.CircleGeometry(size * 0.5, 32);
    case "triangle": {
      const s = size;
      const tri = new THREE.Shape();
      tri.moveTo(0, 0.58 * s);
      tri.lineTo(-0.5 * s, -0.29 * s);
      tri.lineTo(0.5 * s, -0.29 * s);
      tri.closePath();
      return new THREE.ShapeGeometry(tri);
    }
    case "hex": {
      const r = size * 0.5;
      const shp = new THREE.Shape();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const x = Math.cos(a) * r,
          y = Math.sin(a) * r;
        if (i === 0) shp.moveTo(x, y);
        else shp.lineTo(x, y);
      }
      shp.closePath();
      return new THREE.ShapeGeometry(shp);
    }
    // case "diamond": {
    //   const s = size;
    //   const d = new THREE.Shape();
    //   d.moveTo(0, 0.6 * s);
    //   d.lineTo(-0.5 * s, 0);
    //   d.lineTo(0, -0.6 * s);
    //   d.lineTo(0.5 * s, 0);
    //   d.closePath();
    //   return new THREE.ShapeGeometry(d);
    // }
    default:
      return new THREE.PlaneGeometry(size, size);
  }
}

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

function pointInSquare(localPos, halfSize) {
  return (
    localPos.x >= -halfSize &&
    localPos.x <= halfSize &&
    localPos.y >= -halfSize &&
    localPos.y <= halfSize
  );
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

// === Helpers ===
function relayoutSquarePairs(withAnim = true, R) {
  if (!exploded) return;
  cur_radius = R;
  const N = balls.length;
  if (N === 0) return;

  // 1. 找到“最大位移”最小的环偏移
  let bestOffset = 0;
  let minMaxDist = Infinity;
  const testSteps = 60; // 检查多少个偏移角度

  for (let s = 0; s < testSteps; s++) {
    const offset = (s / testSteps) * Math.PI * 2;
    let maxDist = 0;
    for (let i = 0; i < N; i++) {
      const b = balls[i];
      if (!b.containerMesh) continue;
      const p = ringLayout(i, N, offset);
      const dist = b.containerMesh.position.distanceTo(
        new THREE.Vector3(p.x, p.y, 0)
      );
      if (dist > maxDist) maxDist = dist;
    }
    if (maxDist < minMaxDist) {
      minMaxDist = maxDist;
      bestOffset = offset;
    }
  }

  // 2. 用最优偏移布置
  for (let i = 0; i < N; i++) {
    const b = balls[i];
    if (!b.containerMesh) continue;
    const p = ringLayout(i, N, bestOffset);

    if (withAnim) {
      gsap.to(b.containerMesh.position, {
        x: p.x,
        y: p.y,
        duration: 0.6,
        ease: "power2.inOut",
      });
      gsap.to(b.mesh.position, {
        x: p.x,
        y: p.y,
        duration: 0.6,
        ease: "power2.inOut",
      });
    } else {
      b.containerMesh.position.set(p.x, p.y, 0);
      b.mesh.position.set(p.x, p.y, -0.01);
    }
  }
}

// ringLayout 支持 offsetAngle
function ringLayout(i, count, offsetAngle = 0) {
  const angle = (i / Math.max(1, count)) * Math.PI * 2 + offsetAngle;
  return new THREE.Vector2(
    Math.cos(angle) * cur_radius,
    Math.sin(angle) * cur_radius
  );
}
// === 方块形态：新增「方块 + 小球」一对 ===
function addSquareBallPair() {
  const i = balls.length;
  const p = new THREE.Vector2(0, 0);

  // 球
  const color = new THREE.Color().setHSL(Math.random(), 0.75, 0.55);
  const matBall = new THREE.MeshBasicMaterial({ color });
  const meshBall = new THREE.Mesh(
    new THREE.CircleGeometry(BALL_RADIUS, 32),
    matBall
  );
  meshBall.position.set(p.x, p.y, -0.01);
  scene.add(meshBall);

  const ball = {
    mesh: meshBall,
    color,
    vel: new THREE.Vector2(),
    state: "INSIDE",
  };
  balls.push(ball);

  // 这个球的专属方块（克隆 shader + 半径更小）
  const mat = glassMat.clone();
  mat.uniforms = THREE.UniformsUtils.clone(glassMat.uniforms);
  mat.uniforms.uLightCount.value = 1;
  mat.uniforms.uLightPos.value[0] = new THREE.Vector2(p.x, p.y);
  mat.uniforms.uLightColor.value[0] = color.clone();
  mat.uniforms.uRadiusWorld.value = 0.2; // 方块形态：更紧的光斑
  mat.uniforms.uIntensity.value = 0.9;

  const geometry = makeContainerGeometry(CONTAINER_TYPE, SQUARE_SIZE);

  const meshSquare = new THREE.Mesh(geometry, mat);

  meshSquare.position.set(p.x, p.y, 0);
  scene.add(meshSquare);

  squareBlocks.push(meshSquare);

  // 绑定关系
  ball.containerMesh = meshSquare;
  ball.bounds = SQUARE_SIZE * 0.5;

  // 小弹入动效
  gsap.from(meshSquare.scale, {
    x: 0.01,
    y: 0.01,
    duration: 0.4,
    ease: "back.out(1.7)",
  });
  gsap.from(meshBall.scale, {
    x: 0.01,
    y: 0.01,
    duration: 0.4,
    ease: "back.out(1.7)",
  });
  cur_radius = NORMAL_RADIUS;
  relayoutSquarePairs(true, NORMAL_RADIUS); // 每次新增后重排
}

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

// === 从“方块形态”聚拢到“六边形形态” ===
async function gatherToHex() {
  relayoutSquarePairs(true, LARGER_RADIUS);
  await new Promise((resolve) => setTimeout(resolve, 100));

  if (!exploded) return;
  exploded = false;

  ensureHexMeshes();

  if (!scene.children.includes(hexMesh)) scene.add(hexMesh);
  if (!scene.children.includes(backMesh)) scene.add(backMesh);

  const tl = gsap.timeline({
    // 注意：不再在这里统一清理；我们让时间线自然延展到最后一个子动画完成后再清理
    onComplete: () => {
      // 清理残留方块
      squareBlocks.forEach((sq) => {
        sq.geometry.dispose();
        sq.material.dispose();
        scene.remove(sq);
      });
      squareBlocks = [];

      // 六边形参数恢复
      glassUniforms.uRadiusWorld.value = 0.5;
      glassUniforms.uIntensity.value = 0.75;
    },
  });

  let maxEnd = 0;

  balls.forEach((b, i) => {
    if (!b.containerMesh) return;

    // 为每个对象生成不同的时长/延迟/缓动
    const dur = GATHER_BASE + Math.random() * GATHER_JITTER;
    const delay = i * GATHER_STAGGER + Math.random() * 0.12;
    const ease = EASES[(Math.random() * EASES.length) | 0];
    const startAt = delay; // 时间线里的“位置”
    const endAt = startAt + dur;
    if (endAt > maxEnd) maxEnd = endAt;

    const sq = b.containerMesh;

    // 容器与小球分别 tween 到中心，但时间各不相同
    const targetX = 0;
    const targetY = 0;

    tl.to(
      sq.position,
      { x: targetX, y: targetY, duration: dur, ease },
      startAt
    );
    // 小球 tween（保持不变的 x,y 目标），只新增 onUpdate
    tl.to(
      b.mesh.position,
      {
        x: 0,
        y: 0,
        duration: dur,
        ease,
        onUpdate: function () {
          // 到原点的距离（你在根节点 tween 到 0,0）
          const dist = Math.hypot(b.mesh.position.x, b.mesh.position.y);
          if (!b.isHidden && dist <= HEX_RADIUS) {
            b.isHidden = true;
            b.mesh.visible = false; // 只隐藏网格
            // 不要 this.kill()，让位置继续更新，这样光还能动
          }
        },
      },
      startAt
    );

    // 在该对象抵达中心的时刻，给它一个随机“起始相位/速度”，并切到六边形状态
    tl.to(
      sq.position,
      {
        x: targetX,
        y: targetY,
        duration: dur,
        ease,
        onUpdate: () => {
          const dist = Math.sqrt(sq.position.x ** 2 + sq.position.y ** 2);
          if (dist <= HEX_RADIUS) {
            // 移除当前容器
            sq.geometry.dispose();
            sq.material.dispose();
            scene.remove(sq);
            const idx = squareBlocks.indexOf(sq);
            if (idx >= 0) squareBlocks.splice(idx, 1);
          }
        },
      },
      startAt
    );
  });

  cur_radius = NORMAL_RADIUS;

  // 时间线结束点：确保 onComplete 在所有 tween 完毕后触发
  //（tl 的 duration 会自动取决于最后一个子动画的结束时间，这里只是显式保证）
  tl.to({}, { duration: 0 }, maxEnd);
}

// === 从“六边形形态”炸回“方块形态” ===
function explodeFromHex() {
  if (exploded) return;
  exploded = true;

  // 从场景移除六边形
  if (hexMesh) scene.remove(hexMesh);
  if (backMesh) scene.remove(backMesh);

  // 如果你有随机形状选择器，放开这行；否则保持当前 CONTAINER_TYPE
  if (typeof pickNextShape === "function") pickNextShape();

  squareBlocks = [];
  const N = balls.length;

  for (let i = 0; i < N; i++) {
    const b = balls[i];

    // 让被吸收隐藏的球回归显示，并清理/复位
    b.isHidden = false;
    b.mesh.visible = true;
    gsap.killTweensOf(b.mesh.position); // 停掉 gather 时遗留的 tween
    b.vel.set(0, 0);

    // 材质（独立 uniforms，灯光跟随这个球）
    const mat = glassMat.clone();
    mat.uniforms = THREE.UniformsUtils.clone(glassMat.uniforms);
    mat.uniforms.uLightCount.value = 1;
    mat.uniforms.uLightPos.value[0] = new THREE.Vector2(
      b.mesh.position.x,
      b.mesh.position.y
    );
    mat.uniforms.uLightColor.value[0] = b.color.clone();
    mat.uniforms.uRadiusWorld.value = 0.2;
    mat.uniforms.uIntensity.value = 0.9;

    // 几何（用你的工厂；没有就按 square/circle）
    let geo;
    if (typeof makeContainerGeometry === "function") {
      const shapeType =
        typeof CONTAINER_TYPE !== "undefined"
          ? CONTAINER_TYPE
          : typeof currentContainerShape !== "undefined"
          ? currentContainerShape
          : "square";
      geo = makeContainerGeometry(shapeType, SQUARE_SIZE);
    } else {
      geo =
        CONTAINER_TYPE === "circle"
          ? new THREE.CircleGeometry(SQUARE_SIZE * 0.5, 32)
          : new THREE.PlaneGeometry(SQUARE_SIZE, SQUARE_SIZE);
    }

    const sq = new THREE.Mesh(geo, mat);
    sq.position.set(0, 0, 0);
    scene.add(sq);

    // 记录关系（球不是子对象；只建立引用，方便物理吸引/局部判定）
    squareBlocks.push(sq);
    b.containerMesh = sq;
    b.bounds = SQUARE_SIZE * 0.5;
    b.state = "INSIDE";

    // 目标：环上位置
    const p = ringLayout(i, N);

    // 球和方块一起从中心飞回环上
    gsap.to(sq.position, { x: p.x, y: p.y, duration: 1.0, ease: "power2.out" });
    gsap.to(b.mesh.position, {
      x: p.x,
      y: p.y,
      duration: 1.0,
      ease: "power2.out",
    });
    gsap.to(sq.rotation, { z: Math.PI * 2, duration: 1.0, ease: "power2.out" });
  }

  // 爆炸后做一次最小位移重排（可保留/可删）
  if (typeof relayoutSquarePairs === "function") {
    relayoutSquarePairs(true, cur_radius);
  }
}

// === 键盘：A 加对；S 聚拢 ===
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "a") {
    if (exploded) {
      addSquareBallPair(); // 方块形态：A 新增方块+小球
    } else {
      explodeFromHex(); // 六边形形态：先炸回去
      // addSquareBallPair();
    }
  }
  if (k === "s") {
    if (exploded) {
      gatherToHex(); // 方块形态：S 聚拢成六边形
    } else {
      explodeFromHex(); //（可选）六边形形态：S 再次炸回方块
    }
  }
});

// === 先给点初始内容：默认方块形态下加 6 对 ===
for (let i = 0; i < 1; i++) addSquareBallPair();

// === Animate ===
const clock = new THREE.Clock();
const tmpV3 = new THREE.Vector3();
const tmpV2 = new THREE.Vector2();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (exploded && balls.length > 0) {
    ringAngle += ANGULAR_SPEED * dt; // 不断累加相位

    const N = balls.length;
    for (let i = 0; i < N; i++) {
      const b = balls[i];
      if (!b.containerMesh) continue; // 六边形形态下为 null

      const a = (i / N) * Math.PI * 2 + ringAngle;
      const x = Math.cos(a) * cur_radius;
      const y = Math.sin(a) * cur_radius;

      // 直接设容器的世界位置（你的吸引力会让小球跟上）
      b.containerMesh.position.set(x, y, 0);

      // 让方块自身也优雅地转一转（可选）
      b.containerMesh.rotation.z += 0.6 * dt;
    }
  }

  for (const b of balls) {
    const m = b.mesh;
    let inside = false;

    if (!exploded) {
      // 六边形判定（世界坐标）
      const pos2 = new THREE.Vector2(m.position.x, m.position.y);
      inside = pointInConvexPolygon(pos2);
    } else {
      // 方块局部判定（把世界坐标转到该方块的局部）
      tmpV3.copy(m.position);
      const local = b.containerMesh.worldToLocal(tmpV3.clone());
      tmpV2.set(local.x, local.y);
      inside = pointInSquare(tmpV2, b.bounds);
    }

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
  if (!exploded && hexMesh) {
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
