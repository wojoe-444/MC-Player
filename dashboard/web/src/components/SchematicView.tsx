import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import type { Built, MeshData, Prepared } from "@/lib/schematic/mesher"

export type SchematicViewHandle = { setView: (v: "iso" | "front" | "top") => void; screenshot: () => string | null }
export type Hover = { cell: number; x: number; y: number; z: number; px: number; py: number }
type Props = {
  prep: Prepared
  built: Built
  spin: boolean
  ground: boolean
  onHover: (h: Hover | null) => void
  onUnavailable?: () => void
  className?: string
}

/** a CSS colour (any syntax the browser knows: hex, oklch ...) as three.js colour; the viewer takes its colours from the dashboard theme */
function themeColor(name: string, fallback: string): THREE.Color {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
    const cv = document.createElement("canvas"); cv.width = cv.height = 1
    const ctx = cv.getContext("2d", { willReadFrequently: true })
    if (!ctx) return new THREE.Color(fallback)
    ctx.fillStyle = fallback; ctx.fillStyle = raw; ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return new THREE.Color().setRGB(d[0] / 255, d[1] / 255, d[2] / 255, THREE.SRGBColorSpace)
  } catch { return new THREE.Color(fallback) }
}

function geometryOf(d: MeshData): THREE.BufferGeometry | null {
  if (!d.indices.length) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(d.positions, 3))
  g.setAttribute("uv", new THREE.BufferAttribute(d.uvs, 2))
  g.setAttribute("color", new THREE.BufferAttribute(d.colors, 3))
  g.setIndex(new THREE.BufferAttribute(d.indices, 1))
  g.computeBoundingSphere()
  return g
}

type Rig = {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls
  texture: THREE.DataTexture; opaqueMat: THREE.MeshBasicMaterial; transMat: THREE.MeshBasicMaterial; ghostMat: THREE.MeshBasicMaterial
  world: THREE.Group; meshes: { opaque: THREE.Mesh | null; trans: THREE.Mesh | null; ghost: THREE.Mesh | null }
  ground: THREE.Group; box: THREE.LineSegments; frame: number; theme: () => void
}

/** The build, drawn block by block with its textures: orbit, pan, zoom, hover to inspect. */
export const SchematicView = forwardRef<SchematicViewHandle, Props>(function SchematicView({ prep, built, spin, ground, onHover, onUnavailable, className }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const rig = useRef<Rig | null>(null)
  const over = useRef(false)   // the pointer is on a block: hold the spin so the tooltip and the block stay put
  const spinRef = useRef(spin); spinRef.current = spin
  const hover = useRef((h: Hover | null) => { over.current = h != null; const r = rig.current; if (r) r.controls.autoRotate = spinRef.current && !over.current; onHoverRef.current(h) })
  const onHoverRef = useRef(onHover); onHoverRef.current = onHover
  const prepRef = useRef(prep); prepRef.current = prep
  const builtRef = useRef(built); builtRef.current = built

  const [W, H, D] = prep.model.size
  const dims = useRef([W, H, D]); dims.current = [W, H, D]

  const place = (view: "iso" | "front" | "top") => {
    const r = rig.current; if (!r) return
    const [w, h, d] = dims.current
    const radius = Math.max(1, Math.hypot(w, h, d) / 2), fov = (r.camera.fov * Math.PI) / 180
    const aspect = r.camera.aspect || 1
    const dist = (radius / Math.sin(Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * aspect)))) * 1.0
    const target = new THREE.Vector3(0, h / 2, 0)
    const dir = view === "front" ? new THREE.Vector3(0, 0.12, 1) : view === "top" ? new THREE.Vector3(0, 1, 0.0005) : new THREE.Vector3(1, 0.9, 1.15)
    r.controls.target.copy(target)
    r.camera.position.copy(target).add(dir.normalize().multiplyScalar(dist))
    r.camera.near = Math.max(0.1, dist / 200); r.camera.far = dist * 20; r.camera.updateProjectionMatrix()
    r.controls.update()
  }
  useImperativeHandle(ref, () => ({
    setView: place,
    screenshot: () => { const r = rig.current; if (!r) return null; r.renderer.render(r.scene, r.camera); return r.renderer.domElement.toDataURL("image/png") },
  }), []) // eslint-disable-line react-hooks/exhaustive-deps

  // renderer, scene, controls: once
  useEffect(() => {
    const el = host.current; if (!el) return
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }) } catch { onUnavailable?.(); return }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    el.appendChild(renderer.domElement); renderer.domElement.style.display = "block"
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.dampingFactor = 0.12; controls.screenSpacePanning = true; controls.maxPolarAngle = Math.PI * 0.98
    const opaqueMat = new THREE.MeshBasicMaterial({ vertexColors: true, alphaTest: 0.5 })
    const transMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
    const ghostMat = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xffffff, transparent: true, opacity: 0.07, depthWrite: false })
    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1)
    const world = new THREE.Group(), groundGroup = new THREE.Group()
    scene.add(groundGroup, world)
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }))
    box.visible = false; box.renderOrder = 10; scene.add(box)
    const r: Rig = { renderer, scene, camera, controls, texture, opaqueMat, transMat, ghostMat, world, meshes: { opaque: null, trans: null, ghost: null }, ground: groundGroup, box, frame: 0, theme: () => {} }
    rig.current = r

    // colours follow the dashboard theme (28 schemes): the sky is the page's muted colour, the ground its accent
    r.theme = () => {
      const sky = themeColor("--muted", "#e8e2d6"), floor = themeColor("--accent", "#d9d2c0"), line = themeColor("--border", "#bdb5a2"), ink = themeColor("--foreground", "#222222")
      scene.background = sky
      groundGroup.clear()
      const [w, , d] = dims.current, size = Math.max(w, d) + 14
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: floor }))
      plane.rotation.x = -Math.PI / 2; plane.position.y = -0.03
      const grid = new THREE.GridHelper(size, Math.round(size), line, line); grid.position.y = -0.02
      ;(grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.55
      groundGroup.add(plane, grid)
      ;(box.material as THREE.LineBasicMaterial).color.copy(ink)
      ghostMat.color.copy(ink)
    }
    r.theme()
    const mo = new MutationObserver(() => r.theme())
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-scheme"] })

    const resize = () => {
      const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight)
      renderer.setSize(w, h, false); renderer.domElement.style.width = w + "px"; renderer.domElement.style.height = h + "px"
      camera.aspect = w / h; camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize); ro.observe(el); resize()

    // hover: which block is under the pointer
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
    let pending: PointerEvent | null = null, down = false
    const probe = () => {
      const ev = pending; pending = null
      if (!ev || down) return
      const rect = renderer.domElement.getBoundingClientRect()
      ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      const targets = [r.meshes.opaque, r.meshes.trans].filter(Boolean) as THREE.Mesh[]
      const hit = ray.intersectObjects(targets, false).sort((a, b) => a.distance - b.distance)[0]
      if (!hit || hit.faceIndex == null) { box.visible = false; hover.current(null); return }
      const q = (hit.object.userData.quadCell as Int32Array)[hit.faceIndex >> 1]
      const [w, , d] = dims.current, x = q % w, z = Math.floor(q / w) % d, y = Math.floor(q / (w * d))
      box.position.set(x - w / 2 + 0.5, y + 0.5, z - d / 2 + 0.5); box.visible = true
      hover.current({ cell: q, x, y, z, px: ev.clientX - rect.left, py: ev.clientY - rect.top })
    }
    const move = (ev: PointerEvent) => { pending = ev; requestAnimationFrame(probe) }
    const leave = () => { pending = null; box.visible = false; hover.current(null) }
    const dn = () => { down = true; box.visible = false; hover.current(null) }
    const up = () => { down = false }
    const cv = renderer.domElement
    cv.addEventListener("pointermove", move); cv.addEventListener("pointerleave", leave); cv.addEventListener("pointerdown", dn); window.addEventListener("pointerup", up)

    const tick = () => { r.frame = requestAnimationFrame(tick); controls.update(); renderer.render(scene, camera) }
    tick()
    place("iso")
    return () => {
      cancelAnimationFrame(r.frame); mo.disconnect(); ro.disconnect()
      cv.removeEventListener("pointermove", move); cv.removeEventListener("pointerleave", leave); cv.removeEventListener("pointerdown", dn); window.removeEventListener("pointerup", up)
      controls.dispose()
      for (const m of Object.values(r.meshes)) if (m) { m.geometry.dispose() }
      texture.dispose(); opaqueMat.dispose(); transMat.dispose(); ghostMat.dispose(); renderer.dispose()
      renderer.domElement.remove(); rig.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // a new schematic: its texture atlas, its framing
  useEffect(() => {
    const r = rig.current; if (!r) return
    const a = prep.atlas
    const tex = new THREE.DataTexture(a.pixels, a.width, a.height, THREE.RGBAFormat)
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true
    r.texture.dispose(); r.texture = tex
    r.opaqueMat.map = tex; r.transMat.map = tex; r.opaqueMat.needsUpdate = true; r.transMat.needsUpdate = true
    r.theme(); place("iso")
  }, [prep]) // eslint-disable-line react-hooks/exhaustive-deps

  // what is shown: rebuilt whenever the slicer, the isolate or a toggle changes
  useEffect(() => {
    const r = rig.current; if (!r) return
    for (const k of ["opaque", "trans", "ghost"] as const) { const m = r.meshes[k]; if (m) { r.world.remove(m); m.geometry.dispose(); r.meshes[k] = null } }
    const add = (k: "opaque" | "trans" | "ghost", mat: THREE.Material, order: number) => {
      const d = built[k], g = geometryOf(d); if (!g) return
      const m = new THREE.Mesh(g, mat); m.renderOrder = order; m.userData.quadCell = d.quadCell
      r.world.add(m); r.meshes[k] = m
    }
    add("opaque", r.opaqueMat, 0); add("trans", r.transMat, 1); add("ghost", r.ghostMat, 2)
    r.box.visible = false
  }, [built, prep])

  useEffect(() => { const r = rig.current; if (r) { r.controls.autoRotate = spin && !over.current; r.controls.autoRotateSpeed = 1.6 } }, [spin])
  useEffect(() => { const r = rig.current; if (r && r.ground.children[0]) r.ground.children[0].visible = ground }, [ground, prep])   // the lawn; the grid stays

  return <div ref={host} className={className} />
})
