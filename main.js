const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');

// Load .env file if present
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) return;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && val && !process.env[key]) process.env[key] = val;
    });
  }
})();

let ffmpegPath, ffprobePath;
try { ffmpegPath = require('@ffmpeg-installer/ffmpeg').path; } catch { ffmpegPath = 'ffmpeg'; }
try { ffprobePath = require('@ffprobe-installer/ffprobe').path; } catch { ffprobePath = 'ffprobe'; }

// ── API Service (lazy-loaded after app ready) ──
let apiService;
function getApiService() {
  if (!apiService) apiService = require('./api-service');
  return apiService;
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1000,
    minHeight: 700,
    title: 'Ai ClipMix',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Probe video duration: ffprobe first, then ffmpeg -i fallback ──
function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      if (!err && stdout) {
        const dur = parseFloat(stdout.trim());
        if (!isNaN(dur) && dur > 0) { resolve(dur); return; }
      }
      // ffmpeg -i always exits with code 1 when no output specified; duration is in stderr
      execFile(ffmpegPath, ['-i', filePath, '-f', 'null', '-'], { timeout: 15000 }, (err2, stdout2, stderr2) => {
        const combined = (stderr2 || '') + (stdout2 || '');
        const match = combined.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (match) {
          resolve(parseInt(match[1])*3600 + parseInt(match[2])*60 + parseInt(match[3]) + parseInt(match[4])/100);
        } else {
          reject('无法获取视频时长');
        }
      });
    });
  });
}

ipcMain.handle('probe-duration', async (event, filePath) => {
  try {
    return await probeDuration(filePath);
  } catch {
    return null;
  }
});

ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件',
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'webm', 'avi', 'mkv', 'flv', 'wmv', 'm4v'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return [];
  return result.filePaths.map(fp => ({
    path: fp,
    name: path.basename(fp),
    size: fs.statSync(fp).size,
  }));
});

ipcMain.handle('select-images', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择图片文件',
    filters: [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tiff', 'tif', 'heic', 'heif', 'avif'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return [];
  return result.filePaths.map(fp => ({
    path: fp,
    name: path.basename(fp),
    size: fs.statSync(fp).size,
  }));
});

ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择输出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-default-output-dir', () => {
  const desktop = path.join(app.getPath('desktop'), 'VideoMerge_Output');
  if (!fs.existsSync(desktop)) fs.mkdirSync(desktop, { recursive: true });
  return desktop;
});

// ── Get system fonts ──
ipcMain.handle('get-system-fonts', async () => {
  const fontDirs = process.platform === 'darwin'
    ? ['/System/Library/Fonts', '/Library/Fonts', path.join(app.getPath('home'), 'Library/Fonts')]
    : ['C:\\Windows\\Fonts', path.join(app.getPath('home'), 'AppData\\Local\\Microsoft\\Windows\\Fonts')];

  const fontExts = ['.ttf', '.otf', '.ttc', '.woff', '.woff2'];
  const fonts = [];

  for (const dir of fontDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (fontExts.includes(ext)) {
          const name = path.basename(file, ext).replace(/[-_]/g, ' ');
          fonts.push({ name, path: path.join(dir, file) });
        }
      }
    } catch {}
  }

  fonts.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return fonts;
});

// ── Merge with optional xfade transition ──
ipcMain.handle('merge-videos', async (event, { fileA, fileB, fileC, outputPath, mergeMode, transition, transitionDuration, outputFps, outputBitrate, outputSize, editParams }) => {
  let segments;
  if (mergeMode === 'acb') segments = [fileA, fileC, fileB];
  else if (mergeMode === 'bac') segments = [fileB, fileA, fileC];
  else segments = [fileA, fileB, fileC];

  console.log('[merge-videos] mode:', mergeMode, 'transition:', transition, 'fps:', outputFps, 'bitrate:', outputBitrate, 'size:', outputSize);
  if (editParams) console.log('[merge-videos] editParams:', JSON.stringify(editParams));

  const encOpts = { fps: outputFps, bitrate: outputBitrate, outputSize };

  if (!transition || transition === 'none') {
    return mergeConcat3(event, segments, outputPath, encOpts, editParams);
  }
  const dur = parseFloat(transitionDuration) || 1;
  return mergeXfade3(event, segments, outputPath, transition, dur, encOpts, editParams);
});

function mergeConcat3(event, segments, outputPath, encOpts, editParams) {
  return new Promise((resolve, reject) => {
    const tmpDir = app.getPath('temp');
    const listFile = path.join(tmpDir, `merge_list_${Date.now()}.txt`);
    const content = segments.map(s => `file '${s.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listFile, content);

    const hasEdit = editParams && (editParams.subText || editParams.volume !== 100 || editParams.volumeDb !== 0);
    const hasOutputSize = encOpts.outputSize && encOpts.outputSize !== 'original';
    const needsEncode = hasEdit || hasOutputSize || (encOpts.fps && encOpts.fps !== 'auto') || (encOpts.bitrate && encOpts.bitrate !== 'auto');

    let args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];

    if (needsEncode) {
      const vFilters = [];

      if (hasOutputSize) {
        const [ow, oh] = encOpts.outputSize.split('x');
        vFilters.push(`scale=${ow}:${oh}:force_original_aspect_ratio=decrease,pad=${ow}:${oh}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
      } else if (editParams && editParams.width && editParams.height) {
        vFilters.push(`scale=${editParams.width}:${editParams.height}:force_original_aspect_ratio=decrease,pad=${editParams.width}:${editParams.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
      }
      if (editParams && editParams.subText) {
        const dt = buildDrawtext(editParams);
        if (dt) vFilters.push(dt);
      }

      const aFilters = [];
      if (editParams && (editParams.volume !== 100 || editParams.volumeDb !== 0)) {
        const volFactor = (editParams.volume / 100) * Math.pow(10, (editParams.volumeDb || 0) / 20);
        aFilters.push(`volume=${volFactor.toFixed(3)}`);
      }

      if (vFilters.length || aFilters.length) {
        let fc = '';
        if (vFilters.length) fc += `[0:v]${vFilters.join(',')}[vout]`;
        if (aFilters.length) fc += (fc ? ';' : '') + `[0:a]${aFilters.join(',')}[aout]`;
        args.push('-filter_complex', fc);
        if (vFilters.length) args.push('-map', '[vout]');
        else args.push('-map', '0:v');
        if (aFilters.length) args.push('-map', '[aout]');
        else args.push('-map', '0:a');
      }

      if (encOpts.fps && encOpts.fps !== 'auto') args.push('-r', encOpts.fps);
      args.push('-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p');
      if (encOpts.bitrate && encOpts.bitrate !== 'auto') {
        args.push('-b:v', `${encOpts.bitrate}k`);
      } else {
        args.push('-crf', '18');
      }
      args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath);
    } else {
      args.push('-c', 'copy', '-movflags', '+faststart', outputPath);
    }

    const proc = execFile(ffmpegPath, args, { maxBuffer: 50 * 1024 * 1024 }, (error) => {
      try { fs.unlinkSync(listFile); } catch {}
      if (error) reject(error.message);
      else resolve({ outputPath, size: fs.statSync(outputPath).size });
    });
    proc.stderr.on('data', d => event.sender.send('ffmpeg-log', d.toString()));
  });
}

// Build FFmpeg drawtext filter from edit params
function buildDrawtext(ep) {
  if (!ep || !ep.subText) return '';
  const text = ep.subText.replace(/'/g, "\\'").replace(/:/g, '\\:');
  const color = (ep.fontColor || '#ffffff').replace('#', '');
  const scale = (ep.subScale || 100) / 100;
  const size = Math.round((ep.fontSize || 48) * scale);
  const border = ep.subBorder || 2;
  const opacity = (ep.subOpacity ?? 100) / 100;

  let x = '(w-text_w)/2', y = 'h-th-60';
  if (ep.subPos === 'top') { y = '40'; }
  else if (ep.subPos === 'center') { y = '(h-text_h)/2'; }
  else if (ep.subPos === 'bottom-left') { x = '40'; y = 'h-th-60'; }
  else if (ep.subPos === 'bottom-right') { x = 'w-tw-40'; y = 'h-th-60'; }

  let fontPart = '';
  if (ep.fontFamily) {
    fontPart = `:fontfile='${ep.fontFamily.replace(/'/g, "\\'")}'`;
  }

  let alphaPart = opacity < 1 ? `:alpha=${opacity.toFixed(2)}` : '';

  return `drawtext=text='${text}':fontsize=${size}:fontcolor=0x${color}:x=${x}:y=${y}:borderw=${border}:bordercolor=black${fontPart}${alphaPart}`;
}

function probeInfo(filePath) {
  return new Promise((resolve) => {
    execFile(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration:format=duration',
      '-of', 'json',
      filePath,
    ], { timeout: 15000 }, (err, stdout) => {
      try {
        const data = JSON.parse(stdout);
        const s = data.streams?.[0] || {};
        const w = parseInt(s.width) || 1920;
        const h = parseInt(s.height) || 1080;
        const rfr = s.r_frame_rate || '30/1';
        const [num, den] = rfr.split('/').map(Number);
        const fps = (den && den > 0) ? num / den : 30;
        const dur = parseFloat(s.duration) || parseFloat(data.format?.duration) || 0;
        resolve({ w, h, fps: Math.round(fps), dur });
      } catch {
        resolve({ w: 1920, h: 1080, fps: 30, dur: 0 });
      }
    });
  });
}

function hasAudioStream(filePath) {
  return new Promise((resolve) => {
    execFile(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      filePath,
    ], { timeout: 10000 }, (err, stdout) => {
      resolve(!err && stdout && stdout.trim().length > 0);
    });
  });
}

// Three-segment xfade: seg0 → (xfade) → seg1 → (xfade) → seg2
async function mergeXfade3(event, segments, outputPath, transition, duration, encOpts, editParams) {
  const infos = await Promise.all(segments.map(s => probeInfo(s)));
  for (let i = 0; i < infos.length; i++) {
    if (infos[i].dur <= 0) infos[i].dur = await probeDuration(segments[i]);
  }

  let tw, th;
  if (encOpts.outputSize && encOpts.outputSize !== 'original') {
    const [ow, oh] = encOpts.outputSize.split('x').map(Number);
    tw = ow; th = oh;
  } else {
    tw = Math.max(...infos.map(i => i.w));
    th = Math.max(...infos.map(i => i.h));
  }
  const autoFps = Math.max(...infos.map(i => i.fps)) || 30;
  const tfps = (encOpts.fps && encOpts.fps !== 'auto') ? parseInt(encOpts.fps) : autoFps;

  // offset1: where first xfade starts (end of seg0 minus transition overlap)
  const offset1 = Math.max(0, infos[0].dur - duration);
  // After first xfade, the combined duration = dur0 + dur1 - duration
  const combinedDur12 = infos[0].dur + infos[1].dur - duration;
  // offset2: where second xfade starts
  const offset2 = Math.max(0, combinedDur12 - duration);

  console.log(`[mergeXfade3] segments: ${segments.map((s,i) => `${path.basename(s)}(${infos[i].dur}s)`).join(' + ')}`);
  console.log(`[mergeXfade3] target: ${tw}x${th}@${tfps}fps, transition=${transition}, dur=${duration}s, offset1=${offset1}s, offset2=${offset2}s`);
  event.sender.send('ffmpeg-log', `三段转场: ${transition} | 时长=${duration}s | offset1=${offset1.toFixed(2)}s | offset2=${offset2.toFixed(2)}s | 输出=${tw}x${th}@${tfps}fps\n`);

  const audioChecks = await Promise.all(segments.map(s => hasAudioStream(s)));
  const allHaveAudio = audioChecks.every(Boolean);

  return new Promise((resolve, reject) => {
    // outputSize takes priority over editParams dimensions
    const outW = tw;
    const outH = th;

    const scaleFilter = (idx) =>
      `[${idx}:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${tfps},format=yuv420p[v${idx}]`;

    // Video: chain two xfade filters
    const vFilters = [
      scaleFilter(0),
      scaleFilter(1),
      scaleFilter(2),
      `[v0][v1]xfade=transition=${transition}:duration=${duration}:offset=${offset1}[vt1]`,
      `[vt1][v2]xfade=transition=${transition}:duration=${duration}:offset=${offset2}[vx]`,
    ];

    // Post-process: drawtext subtitle on xfade output
    const postFilters = [];
    if (editParams && editParams.subText) {
      const dt = buildDrawtext(editParams);
      if (dt) postFilters.push(dt);
    }

    if (postFilters.length) {
      vFilters.push(`[vx]${postFilters.join(',')}[v]`);
    } else {
      // Rename vx to v
      vFilters[vFilters.length - 1] = vFilters[vFilters.length - 1].replace('[vx]', '[v]');
    }

    let filterComplex, mapArgs;
    if (allHaveAudio) {
      const aFilters = [`[0:a][1:a]acrossfade=d=${duration}[at1]`];
      // Apply volume adjustment
      if (editParams && (editParams.volume !== 100 || editParams.volumeDb !== 0)) {
        const volFactor = (editParams.volume / 100) * Math.pow(10, (editParams.volumeDb || 0) / 20);
        aFilters.push(`[at1][2:a]acrossfade=d=${duration},volume=${volFactor.toFixed(3)}[a]`);
      } else {
        aFilters.push(`[at1][2:a]acrossfade=d=${duration}[a]`);
      }
      filterComplex = [...vFilters, ...aFilters].join(';');
      mapArgs = ['-map', '[v]', '-map', '[a]'];
    } else {
      filterComplex = vFilters.join(';');
      mapArgs = ['-map', '[v]', '-an'];
    }

    const bitrateArgs = (encOpts.bitrate && encOpts.bitrate !== 'auto')
      ? ['-b:v', `${encOpts.bitrate}k`]
      : ['-crf', '18'];

    const args = [
      '-y',
      '-i', segments[0], '-i', segments[1], '-i', segments[2],
      '-filter_complex', filterComplex,
      ...mapArgs,
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', ...bitrateArgs,
      ...(allHaveAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
      '-movflags', '+faststart',
      outputPath,
    ];

    console.log('[mergeXfade3] ffmpeg args:', args.join(' '));

    const proc = spawn(ffmpegPath, args);
    let stderrBuf = '';

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      stderrBuf += str;
      event.sender.send('ffmpeg-log', str);
    });

    proc.on('close', (code) => {
      console.log(`[mergeXfade3] ffmpeg exited with code ${code}`);
      if (code !== 0) {
        if (allHaveAudio && (stderrBuf.includes('acrossfade') || stderrBuf.includes('audio'))) {
          console.log('[mergeXfade3] audio error, retrying video-only');
          // Retry without audio
          const vOnly = vFilters.join(';');
          const args2 = [
            '-y',
            '-i', segments[0], '-i', segments[1], '-i', segments[2],
            '-filter_complex', vOnly,
            '-map', '[v]', '-an',
            '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', ...bitrateArgs,
            '-movflags', '+faststart',
            outputPath,
          ];
          const proc2 = spawn(ffmpegPath, args2);
          proc2.stderr.on('data', d => event.sender.send('ffmpeg-log', d.toString()));
          proc2.on('close', code2 => {
            if (code2 !== 0) reject(`FFmpeg 退出码 ${code2}`);
            else resolve({ outputPath, size: fs.statSync(outputPath).size });
          });
          proc2.on('error', err => reject(err.message));
        } else {
          const lastLines = stderrBuf.split('\n').filter(l=>l.trim()).slice(-5).join(' | ');
          reject(`FFmpeg 退出码 ${code}: ${lastLines}`);
        }
      } else {
        resolve({ outputPath, size: fs.statSync(outputPath).size });
      }
    });
    proc.on('error', err => reject(err.message));
  });
}

ipcMain.handle('get-file-info', async (event, filePath) => {
  try {
    const stat = fs.statSync(filePath);
    return { path: filePath, name: path.basename(filePath), size: stat.size };
  } catch { return null; }
});

ipcMain.handle('export-edited-video', async (event, { inputPath, outputPath, editParams }) => {
  return new Promise((resolve, reject) => {
    const ep = editParams || {};
    const filters = [];

    // Trim via seek
    const inputArgs = [];
    if (ep.trimStart > 0) inputArgs.push('-ss', String(ep.trimStart));
    if (ep.trimEnd > 0 && ep.trimEnd > (ep.trimStart || 0)) inputArgs.push('-to', String(ep.trimEnd));

    // Scale
    if (ep.width && ep.height) {
      filters.push(`scale=${ep.width}:${ep.height}:force_original_aspect_ratio=decrease,pad=${ep.width}:${ep.height}:(ow-iw)/2:(oh-ih)/2`);
    }

    // Drawtext
    const dt = buildDrawtext(ep);
    if (dt) filters.push(dt);

    // Volume
    let audioFilter = '';
    if (ep.volume && ep.volume !== 100) {
      audioFilter = `volume=${(ep.volume / 100).toFixed(2)}`;
    } else if (ep.volumeDb && ep.volumeDb !== 0) {
      audioFilter = `volume=${ep.volumeDb}dB`;
    }

    const args = [...inputArgs, '-i', inputPath];
    if (filters.length > 0 || audioFilter) {
      let fc = '';
      if (filters.length > 0) fc += `[0:v]${filters.join(',')}[vout]`;
      if (audioFilter) fc += (fc ? ';' : '') + `[0:a]${audioFilter}[aout]`;
      args.push('-filter_complex', fc);
      if (filters.length > 0) args.push('-map', '[vout]');
      else args.push('-map', '0:v');
      if (audioFilter) args.push('-map', '[aout]');
      else args.push('-map', '0:a?');
    }

    args.push('-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-b:a', '192k');
    args.push('-movflags', '+faststart', '-y', outputPath);

    console.log('[ExportEdit]', ffmpegPath, args.join(' '));
    const proc = require('child_process').spawn(ffmpegPath, args);
    let stderrBuf = '';
    proc.stderr.on('data', d => {
      stderrBuf += d.toString();
      event.sender.send('ffmpeg-log', d.toString());
    });
    proc.on('close', code => {
      if (code !== 0) {
        const lastLines = stderrBuf.split('\n').filter(l => l.trim()).slice(-5).join(' | ');
        reject(`FFmpeg 退出码 ${code}: ${lastLines}`);
      } else {
        resolve({ outputPath, size: fs.statSync(outputPath).size });
      }
    });
    proc.on('error', err => reject(err.message));
  });
});

ipcMain.handle('get-file-url', async (event, filePath) => {
  return pathToFileURL(filePath).href;
});

ipcMain.handle('open-folder', async (event, folderPath) => shell.openPath(folderPath));
ipcMain.handle('open-file', async (event, filePath) => shell.showItemInFolder(filePath));

// ── API Configuration IPC Handlers ──

ipcMain.handle('api-get-config', async () => {
  const svc = getApiService();
  return svc.loadConfig();
});

ipcMain.handle('api-save-config', async (event, config) => {
  const svc = getApiService();
  svc.saveConfig(config);
  return { success: true };
});

ipcMain.handle('api-test-connection', async (event, service) => {
  const svc = getApiService();
  const config = svc.loadConfig();
  const target = config[service];
  if (!target || !target.apiKey) {
    return { success: false, error: 'API Key not set' };
  }
  try {
    const url = `${target.endpoint}/models?key=${target.apiKey}`;
    return await new Promise((resolve) => {
      const lib = url.startsWith('https') ? require('https') : require('http');
      const req = lib.get(url, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, message: `Connected (HTTP ${res.statusCode})` });
          } else {
            resolve({ success: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 100)}` });
          }
        });
      });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('api-generate-image', async (event, params) => {
  const svc = getApiService();
  try {
    const result = await svc.generateImage(params, (progress) => {
      event.sender.send('ai-progress', { type: 't2i', ...progress });
    });
    svc.addHistory({ type: 't2i', params, result });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message, code: err.code };
  }
});

ipcMain.handle('api-generate-video', async (event, params) => {
  const svc = getApiService();
  try {
    const result = await svc.generateVideo(params, (progress) => {
      event.sender.send('ai-progress', { type: 'i2v', ...progress });
    });
    svc.addHistory({ type: 'i2v', params: { ...params, imagePath: path.basename(params.imagePath) }, result });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message, code: err.code };
  }
});

ipcMain.handle('api-get-history', async () => {
  const svc = getApiService();
  return svc.loadHistory();
});

ipcMain.handle('api-clear-history', async () => {
  const svc = getApiService();
  svc.clearHistory();
  return { success: true };
});

ipcMain.handle('api-save-generated-file', async (event, { data, filename, type }) => {
  const svc = getApiService();
  const config = svc.loadConfig();
  let outputDir = config.general.outputDir;
  if (!outputDir) {
    outputDir = path.join(app.getPath('downloads'), 'Ai-ClipMix-Output');
  }
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const ext = type === 'video' ? '.mp4' : '.png';
  const outPath = path.join(outputDir, (filename || `generated_${Date.now()}`) + ext);

  const buffer = Buffer.from(data, 'base64');
  fs.writeFileSync(outPath, buffer);
  return { success: true, path: outPath };
});
