import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: {
    codec_type?: string;
    width?: number;
    height?: number;
    duration?: string;
    side_data_list?: { rotation?: number }[];
    tags?: { rotate?: string };
  }[];
}

/**
 * Extract duration and dimensions with ffprobe. Optional: when the binary is
 * missing or fails we log and return nulls rather than failing the upload.
 * ffprobe is bundled in the Docker image (see docker/Dockerfile).
 */
export async function probeMedia(
  filePath: string,
  options: { ffprobePath?: string; logger?: Logger } = {},
): Promise<ProbeResult> {
  const binary = options.ffprobePath ?? 'ffprobe';
  const empty: ProbeResult = { durationSeconds: null, width: null, height: null };
  try {
    const { stdout } = await execFileAsync(
      binary,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
    const duration = Number(parsed.format?.duration ?? video?.duration);
    let width = video?.width ?? null;
    let height = video?.height ?? null;
    const rotation = Math.abs(
      Number(video?.side_data_list?.[0]?.rotation ?? video?.tags?.rotate ?? 0),
    );
    if (width && height && (rotation === 90 || rotation === 270)) {
      [width, height] = [height, width];
    }
    return {
      durationSeconds:
        Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) / 1000 : null,
      width,
      height,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      options.logger?.warn({ binary }, 'ffprobe not found; media metadata will be unavailable');
    } else {
      options.logger?.warn({ err: error }, 'ffprobe failed; media metadata will be unavailable');
    }
    return empty;
  }
}
