import { useEffect, useImperativeHandle, useMemo, useRef, forwardRef } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { buildMesh } from "@/lib/cast/mesh"
import type { CastData } from "@/lib/cast/types"

export type CastColor = "metal" | "parts" | "digs"
export type CastViewHandle = { resetView: () => void; screenshot: () => string | null }

// Part tints used by "By part". The cast itself is a silver metal: these only show with that mode on.
const KIND_TINT: Record<string, string> = { shaft: "#d9d9d9", room: "#e8b04a", mobfarm: "#d9625b", farm: "#79b86a", tunnel: "#6fa8dc" }
const MARKER_TINT: Record<string, string> = { chest: "#f2c14e", table: "#c98f5a", furnace: "#e8794a", hopper: "#9aa0a6", bed: "#d97ba1" }

function disposeObject(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
    const mat = m.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else if (mat) mat.dispose()
  })
}

type Props = {
  data: CastData
  color: CastColor
  selected: string | null          // part id to pick out; the rest turns dull
  showMarkers: boolean
  spin: boolean
  className?: string
}

/** The cast: a smooth metal surface of the base's dug and built space, in an orbitable view. */
export const CastView = forwardRef<CastViewHandle, Props>(function CastView({ data, color, selected, showMarkers, spin, className }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const three = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; fit: () => void; mesh: THREE.Mesh | null; markers: THREE.Group; frame: number } | null>(null)
  const mesh = useMemo(() => buildMesh(data), [data])

  useImperativeHandle(ref, () => ({
    resetView: () => three.current?.fit(),
    screenshot: () => { const t = three.current; if (!t) return null; t.renderer.render(t.scene, t.camera); return t.renderer.domElement.toDataURL("image/png") },
  }), [])

  // scene, renderer, controls: once
  useEffect(() => {
    const el = host.current
    if (!el) return
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    el.appendChild(renderer.domElement)
    renderer.domElement.style.display = "block"
    renderer.domElement.style.width = "100%"
    renderer.domElement.style.height = "100%"
    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.03).texture
    scene.environment = env
    scene.add(new THREE.HemisphereLight(0xffffff, 0x303038, 0.25))
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(60, 140, 80); scene.add(key)
    const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 4000)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.autoRotateSpeed = 0.9
    const markers = new THREE.Group(); scene.add(markers)
    const t = { renderer, scene, camera, controls, mesh: null as THREE.Mesh | null, markers, frame: 0, fit: () => {} }
    three.current = t
    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize); ro.observe(el); resize()
    const loop = () => { t.frame = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera) }
    loop()
    return () => {
      cancelAnimationFrame(t.frame); ro.disconnect(); controls.dispose()
      disposeObject(scene); env.dispose(); pmrem.dispose(); renderer.dispose()
      renderer.domElement.remove(); three.current = null
    }
  }, [])

  // geometry: when the data changes
  useEffect(() => {
    const t = three.current
    if (!t) return
    if (t.mesh) { t.scene.remove(t.mesh); disposeObject(t.mesh); t.mesh = null }
    if (!mesh) return
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3))
    g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3))
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.positions.length), 3))
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
    g.computeBoundingSphere()
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 0.24, envMapIntensity: 1.35, side: THREE.DoubleSide })
    const m = new THREE.Mesh(g, mat)
    t.scene.add(m); t.mesh = m
    // the surface the metal was poured from: a low disc at ground level, a little wider than the cast
    const gy = data.base.y - 1 - 0.5
    const cx = (mesh.min[0] + mesh.max[0]) / 2, cz = (mesh.min[2] + mesh.max[2]) / 2
    const rad = Math.max(mesh.max[0] - mesh.min[0], mesh.max[2] - mesh.min[2]) / 2 + 8
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad * 1.04, 1.4, 64), new THREE.MeshStandardMaterial({ color: 0x3a3733, roughness: 0.9, metalness: 0.1 }))
    disc.position.set(cx, gy - 0.2, cz)
    t.scene.add(disc)
    const target = new THREE.Vector3(cx, (Math.min(mesh.min[1], gy) + Math.max(mesh.max[1], gy)) / 2, cz)
    const height = Math.max(mesh.max[1], gy) - Math.min(mesh.min[1], gy)
    const radius = Math.max(height / 2, rad, 12)
    t.fit = () => {
      const dist = (radius / Math.tan((t.camera.fov * Math.PI) / 360)) * 1.15
      t.camera.position.set(target.x + dist * 0.62, target.y + dist * 0.28, target.z + dist * 0.74)
      t.controls.target.copy(target); t.controls.update()
    }
    t.fit()
    return () => { t.scene.remove(disc); disposeObject(disc) }
  }, [mesh, data.base.y])

  // markers: chests, tables, furnaces
  useEffect(() => {
    const t = three.current
    if (!t) return
    while (t.markers.children.length) { const c = t.markers.children[0]; t.markers.remove(c); disposeObject(c) }
    if (!showMarkers) return
    const geo = new THREE.OctahedronGeometry(0.55, 0)
    for (const mk of data.markers) {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: MARKER_TINT[mk.type] ?? "#f2c14e", metalness: 0.4, roughness: 0.35, emissive: MARKER_TINT[mk.type] ?? "#f2c14e", emissiveIntensity: 0.35 }))
      m.position.set(mk.x, mk.y, mk.z); m.userData.label = mk.label
      t.markers.add(m)
    }
  }, [data.markers, showMarkers])

  // colours: metal / by part / recorded vs derived, with an optional part picked out
  useEffect(() => {
    const t = three.current
    if (!t || !t.mesh || !mesh) return
    const attr = t.mesh.geometry.getAttribute("color") as THREE.BufferAttribute
    const silver = new THREE.Color("#d4d8de"), dull = new THREE.Color("#6d7077"), warm = new THREE.Color("#f4d8a8")
    const tmp = new THREE.Color()
    const partColor = data.parts.map((p) => new THREE.Color(KIND_TINT[p.kind] ?? "#ffffff"))
    const selIdx = selected ? data.parts.findIndex((p) => p.id === selected) : -1
    for (let i = 0; i < mesh.part.length; i++) {
      const pi = mesh.part[i] - 1
      if (color === "parts") tmp.copy(pi >= 0 ? partColor[pi] : silver)
      else if (color === "digs") tmp.copy(mesh.recorded[i] ? warm : dull)
      else tmp.copy(silver)
      if (selIdx >= 0 && pi !== selIdx) tmp.multiplyScalar(0.28)
      attr.setXYZ(i, tmp.r, tmp.g, tmp.b)
    }
    attr.needsUpdate = true
  }, [mesh, color, selected, data.parts])

  useEffect(() => { const t = three.current; if (t) t.controls.autoRotate = spin }, [spin])

  return <div ref={host} className={className} />
})
