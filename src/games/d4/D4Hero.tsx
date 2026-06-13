// Спільний background-hero для всіх D4-сторінок (Text/Fonts/Textures).
// Фонове зображення d4-hero.png + червоний градієнт-overlay у noir-стилі гри.

import heroImage from "./assets/d4-hero.png";

interface Props {
  /** Якщо true — рендеримо у position:absolute inset:0 з z-index 0, для
   *  використання як фон сторінки. */
  asBackground?: boolean;
}

export function D4Hero({ asBackground = true }: Props) {
  const style: React.CSSProperties = asBackground
    ? { position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none" }
    : {};

  return (
    <div style={style} aria-hidden>
      {/* Background image */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `url(${heroImage})`,
          backgroundSize: "cover",
          backgroundPosition: "center 30%",
          filter: "blur(1px) brightness(0.4) saturate(1.2) contrast(1.05)",
          opacity: 0.75,
        }}
      />
      {/* Top gradient: dark scanlines feel */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(180deg, rgba(13,2,4,0.55) 0%, rgba(13,2,4,0.88) 55%, rgba(13,2,4,0.98) 100%)",
        }}
      />
      {/* Red vignette accent */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse at 50% 0%, rgba(220,38,38,0.18) 0%, transparent 60%)",
        }}
      />
      {/* Subtle film grain via repeating gradient */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "repeating-linear-gradient(0deg, transparent 0 2px, rgba(0,0,0,0.15) 2px 3px)",
          opacity: 0.4,
          mixBlendMode: "multiply",
        }}
      />
    </div>
  );
}
