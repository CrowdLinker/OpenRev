import createGlobe from "cobe";
import { useEffect, useRef } from "react";

export interface GlobeMarker {
  location: [number, number];
  size: number;
  paying?: boolean;
}

/** Interactive WebGL globe (cobe) showing live visitors. Drag to rotate. */
export function Globe({ markers, focus, className }: { markers: GlobeMarker[]; focus?: [number, number] | null; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markersRef = useRef(markers);
  const pointer = useRef<{ x: number; phi: number } | null>(null);
  const phiRef = useRef(0);
  const targetRef = useRef<number | null>(null);
  markersRef.current = markers;

  useEffect(() => {
    if (focus) targetRef.current = -((focus[1] * Math.PI) / 180) - Math.PI / 2;
  }, [focus]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dark = document.documentElement.classList.contains("dark");
    let width = canvas.offsetWidth;
    const onResize = () => (width = canvas.offsetWidth);
    window.addEventListener("resize", onResize);
    const toCobe = (list: GlobeMarker[]) =>
      list.map((m) => ({ location: m.location, size: m.size, ...(m.paying ? { color: [0.06, 0.73, 0.5] as [number, number, number] } : {}) }));
    const globe = createGlobe(canvas, {
      devicePixelRatio: 2,
      width: width * 2,
      height: width * 2,
      phi: 0,
      theta: 0.25,
      dark: dark ? 1 : 0,
      diffuse: dark ? 1.2 : 1.6,
      mapSamples: 16000,
      mapBrightness: dark ? 5 : 6,
      baseColor: dark ? [0.25, 0.25, 0.3] : [0.82, 0.8, 0.95],
      markerColor: [0.43, 0.35, 0.98],
      glowColor: dark ? [0.15, 0.13, 0.3] : [0.96, 0.95, 1],
      markers: toCobe(markersRef.current),
      markerElevation: 0.02,
    });
    // cobe v2 has no render callback: drive rotation and marker updates ourselves.
    let raf = 0;
    let lastMarkers = markersRef.current;
    const loop = () => {
      if (!pointer.current) {
        if (targetRef.current !== null) {
          // Ease along the shortest arc: phi keeps growing while the globe auto-rotates.
          const TAU = Math.PI * 2;
          const diff = ((((targetRef.current - phiRef.current + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
          phiRef.current += diff * 0.06;
          if (Math.abs(diff) < 0.001) targetRef.current = null;
        } else {
          phiRef.current += 0.0025;
        }
      }
      const update: Parameters<typeof globe.update>[0] = { phi: phiRef.current, width: width * 2, height: width * 2 };
      if (markersRef.current !== lastMarkers) {
        lastMarkers = markersRef.current;
        update.markers = toCobe(lastMarkers);
      }
      globe.update(update);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    setTimeout(() => (canvas.style.opacity = "1"));
    return () => {
      cancelAnimationFrame(raf);
      globe.destroy();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div className={className} style={{ aspectRatio: "1 / 1", width: "100%", maxWidth: 620, margin: "0 auto" }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", cursor: "grab", contain: "layout paint size", opacity: 0, transition: "opacity 1s ease" }}
        onPointerDown={(e) => {
          pointer.current = { x: e.clientX, phi: phiRef.current };
          (e.target as HTMLElement).style.cursor = "grabbing";
        }}
        onPointerUp={(e) => {
          pointer.current = null;
          (e.target as HTMLElement).style.cursor = "grab";
        }}
        onPointerOut={() => (pointer.current = null)}
        onPointerMove={(e) => {
          if (pointer.current) phiRef.current = pointer.current.phi + (e.clientX - pointer.current.x) / 150;
        }}
      />
    </div>
  );
}
