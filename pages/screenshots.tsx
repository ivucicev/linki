import Head from "next/head";
import { useState, useEffect, useCallback } from "react";

interface Screenshot {
  filename: string;
  url: string;
  ts: number;
  label: string;
}

export default function ScreenshotsPage() {
  const [shots, setShots] = useState<Screenshot[]>([]);
  const [selected, setSelected] = useState<Screenshot | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/screenshots");
    if (res.ok) setShots(await res.json());
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

  return (
    <>
      <Head>
        <title>Screenshots — Linki</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold">Runner Screenshots</h1>
          <span className="text-xs text-base-content/40">Auto-refreshes every 5s · last 48h kept</span>
        </div>

        {shots.length === 0 ? (
          <div className="text-center py-24 text-base-content/30 text-sm">
            No screenshots yet — run a campaign to start capturing.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {shots.map((s) => (
              <button
                key={s.filename}
                onClick={() => setSelected(s)}
                className="group relative rounded-xl overflow-hidden border border-base-300/50 hover:border-primary/40 transition-colors bg-base-200 text-left"
              >
                <img
                  src={s.url}
                  alt={s.label}
                  className="w-full aspect-video object-cover object-top"
                />
                <div className="p-2">
                  <p className="text-xs font-medium truncate text-base-content/70">{s.label}</p>
                  <p className="text-xs text-base-content/30">
                    {new Date(s.ts).toLocaleTimeString()}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setSelected(null)}
        >
          <div className="max-w-5xl w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-white font-medium">{selected.label}</p>
                <p className="text-white/40 text-xs">{new Date(selected.ts).toLocaleString()}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-white/50 hover:text-white text-2xl leading-none">×</button>
            </div>
            <img src={selected.url} alt={selected.label} className="w-full rounded-xl" />
          </div>
        </div>
      )}
    </>
  );
}
