import {useEffect, useRef, useState} from "react";

import {keysBetween} from "../../shared/fractional";
import type {Shape, ShapeType} from "../../shared/shape";
import {Editor, PALETTE} from "../editor/editor";
import {normalizeStroke} from "../editor/geometry";

/**
 * /bench — how the renderer holds up. Fills a local board (no server) with N
 * random shapes, then flies the camera across it for five seconds and reports
 * the frame times the browser actually delivered.
 */

const SIZES = [1_000, 5_000, 10_000, 20_000];
const DURATION_MS = 5_000;

interface Result {
    count: number;
    fps: number;
    p95: number;
    worst: number;
    render: number;
}

const randomShapes = (count: number): Shape[] => {
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const types: ShapeType[] = ["rect", "ellipse", "line", "arrow", "pen", "note"];
    const keys = keysBetween(null, null, count);
    const spread = Math.sqrt(count) * 90;

    return Array.from({length: count}, (_, index) => {
        const type = types[Math.floor(random() * types.length)]!;
        const color = PALETTE[Math.floor(random() * PALETTE.length)]!;
        const x = (random() - 0.5) * spread;
        const y = (random() - 0.5) * spread;
        const base = {
            id: `b${index}`,
            type,
            x,
            y,
            w: 30 + random() * 90,
            h: 20 + random() * 70,
            stroke: color.stroke,
            fill: type === "rect" || type === "ellipse" ? (random() < 0.5 ? color.pastel : null) : type === "note" ? color.pastel : null,
            strokeWidth: 2,
            z: keys[index]!,
        };
        if (type === "pen") {
            const points = Array.from({length: 12}, (_, step) => ({x: x + step * 8, y: y + Math.sin(step + random()) * 20}));
            return {...base, ...normalizeStroke(points)};
        }
        if (type === "note") return {...base, text: `Note ${index}`};
        return base;
    });
};

const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

export const Bench = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [editor] = useState(() => new Editor({room: "bench", client: "local", local: true}));
    const [count, setCount] = useState(SIZES[2]!);
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState<Result[]>([]);

    useEffect(() => (canvasRef.current ? editor.attach(canvasRef.current) : undefined), [editor]);

    const run = async () => {
        setRunning(true);
        editor.loadShapes(randomShapes(count).filter((shape) => !editor.sync.view.has(shape.id)));
        for (const id of [...editor.sync.view.keys()].filter((id) => Number(id.slice(1)) >= count)) {
            editor.sync.commit([{t: "delete", id}]);
        }
        editor.fitToContent();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const start = editor.camera;
        const {width, height} = editor.viewportSize;
        const frames: number[] = [];
        const renders: number[] = [];
        const began = performance.now();
        let last = began;

        await new Promise<void>((resolve) => {
            const tick = (now: number) => {
                frames.push(now - last);
                renders.push(editor.frameStats.ms);
                last = now;
                const t = (now - began) / DURATION_MS;
                if (t >= 1) return resolve();
                // Zoom in to 4× and back out while panning across the board.
                const zoom = start.zoom * (1 + 3 * Math.sin(t * Math.PI));
                const centerX = start.x + width / 2 / start.zoom + Math.sin(t * Math.PI * 2) * 600;
                const centerY = start.y + height / 2 / start.zoom + Math.cos(t * Math.PI * 2) * 400;
                editor.setCamera({zoom, x: centerX - width / 2 / zoom, y: centerY - height / 2 / zoom});
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });

        frames.shift();
        const average = frames.reduce((sum, frame) => sum + frame, 0) / frames.length;
        setResults((previous) => [
            {
                count,
                fps: Math.round(1000 / average),
                p95: Math.round(percentile(frames, 0.95) * 10) / 10,
                worst: Math.round(Math.max(...frames) * 10) / 10,
                render: Math.round((renders.reduce((sum, ms) => sum + ms, 0) / renders.length) * 10) / 10,
            },
            ...previous,
        ]);
        setRunning(false);
    };

    return (
        <main className="board">
            <canvas ref={canvasRef} className="board-canvas" role="img" aria-label="Benchmark board" />
            <section className="panel bench-panel" aria-labelledby="bench-title">
                <h1 id="bench-title">Renderer benchmark</h1>
                <p>
                    Fills a local board with random shapes and flies the camera across it for five seconds. Nothing
                    here touches the network.
                </p>
                <div className="segmented" role="group" aria-label="Number of shapes">
                    {SIZES.map((size) => (
                        <button key={size} type="button" aria-pressed={count === size} disabled={running} onClick={() => setCount(size)}>
                            {size.toLocaleString("en-US")}
                        </button>
                    ))}
                </div>
                <button type="button" className="primary-button" disabled={running} onClick={run}>
                    {running ? "Running…" : "Run"}
                </button>
                {results.length > 0 && (
                    <table>
                        <thead>
                            <tr>
                                <th scope="col">Shapes</th>
                                <th scope="col">FPS</th>
                                <th scope="col">p95 frame</th>
                                <th scope="col">Worst</th>
                                <th scope="col">Render</th>
                            </tr>
                        </thead>
                        <tbody>
                            {results.map((result, index) => (
                                <tr key={index}>
                                    <td>{result.count.toLocaleString("en-US")}</td>
                                    <td>{result.fps}</td>
                                    <td>{result.p95} ms</td>
                                    <td>{result.worst} ms</td>
                                    <td>{result.render} ms</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <a href="/" className="text-button">
                    ← Back to a board
                </a>
            </section>
        </main>
    );
};
