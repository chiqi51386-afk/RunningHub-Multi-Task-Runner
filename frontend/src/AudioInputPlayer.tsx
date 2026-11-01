import { useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";

function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function AudioInputPlayer({ url }: { url: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState(false);
  const readDuration = () => {
    const value = ref.current?.duration;
    setDuration(value && Number.isFinite(value) && value > 0 ? value : 0);
  };
  return <div className="media-input-audio input-audio-player">
    <audio ref={ref} src={url} preload="metadata" onLoadedMetadata={readDuration} onDurationChange={readDuration}
      onTimeUpdate={event => setCurrent(event.currentTarget.currentTime)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onVolumeChange={event => setMuted(event.currentTarget.muted)} onError={() => { setError(true); setPlaying(false); }} />
    <button type="button" aria-label={playing ? "暂停音频" : "播放音频"} disabled={error} onClick={() => {
      const audio = ref.current;
      if (!audio) return;
      if (!audio.paused) audio.pause();
      else void audio.play().catch(() => setError(true));
    }}>{playing ? <Pause size={19} /> : <Play size={19} />}</button>
    <span className="input-audio-time" aria-label="播放时间">{error ? "音频无法播放" : `${clock(current)} / ${duration ? clock(Math.ceil(duration)) : "--:--"}`}</span>
    <input type="range" className="input-audio-seek" aria-label="音频播放进度" min={0} max={duration || 1} step="any"
      disabled={!duration || error} value={Math.min(current, duration)} onChange={event => {
        if (!ref.current) return;
        ref.current.currentTime = Number(event.target.value);
        setCurrent(ref.current.currentTime);
      }} />
    <button type="button" aria-label={muted ? "取消静音" : "静音"} aria-pressed={muted} onClick={() => {
      if (ref.current) ref.current.muted = !ref.current.muted;
    }}>{muted ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
  </div>;
}
