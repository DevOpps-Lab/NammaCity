"use client";

import { useState } from "react";
import Icon from "./Icon";

export default function BeforeAfterSlider({ beforeUrl, afterUrl }: { beforeUrl: string; afterUrl: string }) {
  const [sliderPos, setSliderPos] = useState(50);

  return (
    <div className="w-full">
      <div 
        className="group relative h-40 w-full select-none overflow-hidden rounded-lg shadow-[var(--shadow-1)] sm:h-48"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const pos = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
          if (e.buttons === 1) setSliderPos(pos);
        }}
        onTouchMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const touch = e.touches[0];
          const pos = Math.max(0, Math.min(100, ((touch.clientX - rect.left) / rect.width) * 100));
          setSliderPos(pos);
        }}
      >
        {/* Before Image (Background) */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={beforeUrl} alt="Before" className="pointer-events-none absolute inset-0 h-full w-full object-cover" />
        
        {/* After Image (Foreground, clipped) */}
        <div 
          className="absolute inset-0 h-full w-full"
          style={{ clipPath: `inset(0 ${100 - sliderPos}% 0 0)` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={afterUrl} alt="After" className="pointer-events-none absolute inset-0 h-full w-full object-cover" />
        </div>
        
        {/* Slider Handle line */}
        <div 
          className="absolute bottom-0 top-0 w-1 cursor-ew-resize bg-white shadow-[0_0_10px_rgba(0,0,0,0.5)]"
          style={{ left: `calc(${sliderPos}% - 2px)` }}
        >
          {/* Thumb circle */}
          <div className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.3)]">
            <Icon name="activity" size={14} className="text-gray-500 opacity-50" />
          </div>
        </div>
      </div>
      
      <figcaption className="mt-1.5 flex items-center justify-between text-[9px] uppercase tracking-wider">
        <span className="text-[var(--text-dim)]">Before</span>
        <span className="text-emerald-700 font-semibold">After · Citizen Verified</span>
      </figcaption>
    </div>
  );
}
