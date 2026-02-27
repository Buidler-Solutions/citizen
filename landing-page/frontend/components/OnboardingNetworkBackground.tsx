'use client';

import { useEffect, useRef } from 'react';

type NodePoint = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseX: number;
  baseY: number;
  driftRadiusX: number;
  driftRadiusY: number;
  driftSpeedX: number;
  driftSpeedY: number;
  driftPhaseX: number;
  driftPhaseY: number;
  cubeSize: number;
  depthFactor: number;
};

const NODE_COUNT = 70;
const CONNECT_DISTANCE = 165;
const POINTER_PULL_RADIUS = 290;
const POINTER_NEAR_RADIUS = 130;

export function OnboardingNetworkBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');

    if (!context) {
      return;
    }

    const pointer = {
      x: 0,
      y: 0,
      active: false,
    };

    const points: NodePoint[] = [];
    let rafId = 0;

    const resetCanvasSize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(window.innerWidth * ratio);
      canvas.height = Math.floor(window.innerHeight * ratio);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const createPoints = () => {
      points.length = 0;
      for (let index = 0; index < NODE_COUNT; index += 1) {
        const x = Math.random() * window.innerWidth;
        const y = Math.random() * window.innerHeight;
        const depthFactor = 0.55 + Math.random() * 0.7;

        points.push({
          x,
          y,
          baseX: x,
          baseY: y,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          driftRadiusX: 12 + Math.random() * 18,
          driftRadiusY: 10 + Math.random() * 16,
          driftSpeedX: 0.00022 + Math.random() * 0.00034,
          driftSpeedY: 0.0002 + Math.random() * 0.0003,
          driftPhaseX: Math.random() * Math.PI * 2,
          driftPhaseY: Math.random() * Math.PI * 2,
          cubeSize: 3.2 + Math.random() * 5.8,
          depthFactor,
        });
      }
    };

    const drawCubeNode = (point: NodePoint) => {
      const size = point.cubeSize * point.depthFactor;
      const half = size / 2;
      const extrusion = Math.max(1.1, size * 0.5);

      const left = point.x - half;
      const top = point.y - half;
      const right = point.x + half;
      const bottom = point.y + half;

      context.fillStyle = `rgba(130, 225, 255, ${0.2 + 0.22 * point.depthFactor})`;
      context.strokeStyle = `rgba(170, 240, 255, ${0.55 + 0.25 * point.depthFactor})`;
      context.lineWidth = 1;
      context.fillRect(left, top, size, size);
      context.strokeRect(left, top, size, size);

      context.beginPath();
      context.moveTo(left, top);
      context.lineTo(left + extrusion, top - extrusion);
      context.lineTo(right + extrusion, top - extrusion);
      context.lineTo(right, top);
      context.closePath();
      context.fillStyle = `rgba(160, 240, 255, ${0.08 + 0.2 * point.depthFactor})`;
      context.fill();
      context.strokeStyle = `rgba(164, 236, 255, ${0.3 + 0.25 * point.depthFactor})`;
      context.stroke();

      context.beginPath();
      context.moveTo(right, top);
      context.lineTo(right + extrusion, top - extrusion);
      context.lineTo(right + extrusion, bottom - extrusion);
      context.lineTo(right, bottom);
      context.closePath();
      context.fillStyle = `rgba(91, 191, 255, ${0.1 + 0.18 * point.depthFactor})`;
      context.fill();
      context.strokeStyle = `rgba(143, 221, 255, ${0.28 + 0.22 * point.depthFactor})`;
      context.stroke();

      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, size * 2.2);
      glow.addColorStop(0, `rgba(180, 242, 255, ${0.42 * point.depthFactor})`);
      glow.addColorStop(1, 'rgba(84, 190, 255, 0)');
      context.fillStyle = glow;
      context.beginPath();
      context.arc(point.x, point.y, size * 2.2, 0, Math.PI * 2);
      context.fill();
    };

    const draw = () => {
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);

      const gradient = context.createRadialGradient(
        window.innerWidth * 0.5,
        window.innerHeight * 0.4,
        0,
        window.innerWidth * 0.5,
        window.innerHeight * 0.4,
        window.innerWidth * 0.75,
      );
      gradient.addColorStop(0, 'rgba(5, 32, 72, 0.38)');
      gradient.addColorStop(0.55, 'rgba(4, 17, 41, 0.22)');
      gradient.addColorStop(1, 'rgba(3, 9, 22, 0.55)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, window.innerWidth, window.innerHeight);

      const now = performance.now();

      for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
        const point = points[pointIndex];
        const driftX = Math.sin(now * point.driftSpeedX + point.driftPhaseX) * point.driftRadiusX;
        const driftY = Math.cos(now * point.driftSpeedY + point.driftPhaseY) * point.driftRadiusY;

        const organicTargetX = point.baseX + driftX;
        const organicTargetY = point.baseY + driftY;

        point.vx += (organicTargetX - point.x) * 0.0014;
        point.vy += (organicTargetY - point.y) * 0.0014;

        point.vx += (Math.random() - 0.5) * 0.005;
        point.vy += (Math.random() - 0.5) * 0.005;

        if (pointer.active) {
          const dx = pointer.x - point.x;
          const dy = pointer.y - point.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;

          if (distance < POINTER_PULL_RADIUS) {
            const normalizedDistance = 1 - distance / POINTER_PULL_RADIUS;
            const nearPointerBoost = distance < POINTER_NEAR_RADIUS ? 1.85 : 1;
            const pullStrength = normalizedDistance * normalizedDistance * 0.034 * nearPointerBoost;
            point.vx += (dx / distance) * pullStrength;
            point.vy += (dy / distance) * pullStrength;
          }
        }

        point.vx *= 0.965;
        point.vy *= 0.965;
        point.x += point.vx;
        point.y += point.vy;

        if (point.x < -20 || point.x > window.innerWidth + 20) {
          point.vx *= -1;
        }
        if (point.y < -20 || point.y > window.innerHeight + 20) {
          point.vy *= -1;
        }
      }

      for (let i = 0; i < points.length; i += 1) {
        const from = points[i];

        for (let j = i + 1; j < points.length; j += 1) {
          const to = points[j];
          const dx = from.x - to.x;
          const dy = from.y - to.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance > CONNECT_DISTANCE) {
            continue;
          }

          const depthBlend = (from.depthFactor + to.depthFactor) * 0.5;
          const alpha = (1 - distance / CONNECT_DISTANCE) * (0.28 + depthBlend * 0.22);
          context.strokeStyle = `rgba(132, 213, 255, ${alpha})`;
          context.lineWidth = 0.8 + depthBlend * 0.65;
          context.beginPath();
          context.moveTo(from.x, from.y);
          context.lineTo(to.x, to.y);
          context.stroke();
        }
      }

      for (let index = 0; index < points.length; index += 1) {
        drawCubeNode(points[index]);
      }

      rafId = window.requestAnimationFrame(draw);
    };

    const handleMove = (event: MouseEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.active = true;
    };

    const handleLeave = () => {
      pointer.active = false;
    };

    const handleResize = () => {
      resetCanvasSize();
      createPoints();
    };

    resetCanvasSize();
    createPoints();
    draw();

    window.addEventListener('resize', handleResize);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseout', handleLeave);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseout', handleLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full opacity-85"
    />
  );
}
