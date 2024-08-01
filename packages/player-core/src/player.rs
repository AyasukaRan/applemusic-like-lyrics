use std::{
    fmt::Debug, io::ErrorKind, sync::Arc, time::{Duration, Instant}
};

use anyhow::Context;

use symphonia::core::io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::{errors::Error as DecodeError, units::Time};
use tokio::{
    sync::{
        mpsc::{error::TryRecvError, UnboundedReceiver, UnboundedSender},
        Mutex, RwLock,
    },
    task::AbortHandle,
};
use tracing::*;

use crate::{AudioPlayerEventSender, AudioThreadEvent, SongSource};

use super::{
    audio_quality::AudioQuality, fft_player::FFTPlayer, output::AudioOutputSender,
    AudioThreadMessage, SongData,
};

#[derive(Debug, Default, Clone, PartialEq)]
struct AudioPlayerTaskData<T> {
    pub current_song: Option<SongData<T>>,
    pub audio_quality: AudioQuality,
}

struct AudioPlayerTaskContext<T> {
    pub app: tokio::sync::mpsc::Sender<AudioThreadEvent<T>>,
    pub audio_tx: AudioOutputSender,
    pub play_rx: UnboundedReceiver<AudioThreadMessage>,
    pub fft_player: Arc<Mutex<FFTPlayer>>,
    pub fft_has_data_sx: UnboundedSender<()>,
    pub play_pos_sx: UnboundedSender<Option<(bool, f64)>>,
    pub current_audio_info: Arc<RwLock<AudioInfo>>,
}

#[derive(Debug, Default, Clone)]
struct AudioInfo {
    pub audio_name: String,
    pub duration: f64,
    pub position: f64,
}

pub struct AudioPlayer<T> {
    evt_sender: AudioPlayerEventSender<T>,

    player: AudioOutputSender,
    volume: f64,
    is_playing: bool,

    playlist: Vec<SongData<T>>,
    playlist_inited: bool,
    current_play_index: usize,
    current_song: Option<SongData<T>>,
    current_audio_info: Arc<RwLock<AudioInfo>>,

    current_play_task_handle: Option<AbortHandle>,

    fft_player: Arc<Mutex<FFTPlayer>>,
    fft_has_data_sx: UnboundedSender<()>,
    play_pos_sx: UnboundedSender<Option<(bool, f64)>>,

    play_task_sx: UnboundedSender<AudioThreadMessage>,
    play_task_data: Arc<Mutex<AudioPlayerTaskData<T>>>,
}

impl<T: SongSource + Debug> AudioPlayer<T> {
    pub fn new(evt_sender: AudioPlayerEventSender<T>, player: AudioOutputSender) -> Self {
        let playlist = Vec::<SongData<T>>::with_capacity(4096);

        let fft_player = Arc::new(Mutex::new(FFTPlayer::new()));
        let (fft_has_data_sx, mut rx) = tokio::sync::mpsc::unbounded_channel();

        let fft_player_clone = fft_player.clone();
        let app_clone = evt_sender.clone();
        tokio::task::spawn(async move {
            let mut buf = [0.0; 64];
            while rx.recv().await.is_some() {
                while fft_player_clone.lock().await.has_data() {
                    let start_it = tokio::time::Instant::now();
                    let it = start_it + Duration::from_millis(10);
                    if fft_player_clone.lock().await.read(&mut buf) {
                        let _ = app_clone
                            .send(
                                "on-audio-thread-event",
                                AudioThreadEvent::FFTData { data: buf.to_vec() },
                            )
                            .await;
                    }
                    tokio::time::sleep_until(it).await;
                    let _ = rx.try_recv();
                }
            }
        });

        let (play_pos_sx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let app_clone = evt_sender.clone();
        tokio::task::spawn(async move {
            let mut is_inited = false;
            let mut last_is_playing = false;
            let mut start_base_time = 0.0;
            let mut inst = Instant::now();
            loop {
                let mut should_wait = false;
                match rx.try_recv() {
                    Ok(Some((is_playing, pos))) => {
                        if !is_inited {
                            is_inited = true;
                            last_is_playing = is_playing;
                            start_base_time = pos;
                        }
                        if is_playing != last_is_playing {
                            last_is_playing = is_playing;
                            start_base_time = pos;
                            if last_is_playing {
                                inst = Instant::now();
                            } else {
                                let _ = app_clone.emit(
                                    "on-audio-thread-event",
                                    AudioThreadEvent::PlayPosition { position: pos },
                                );
                            }
                        } else if !is_playing {
                            start_base_time = pos;
                            inst = Instant::now();
                            let _ = app_clone.emit(
                                "on-audio-thread-event",
                                AudioThreadEvent::PlayPosition { position: pos },
                            );
                        }
                    }
                    Ok(None) => {
                        is_inited = false;
                    }
                    Err(TryRecvError::Disconnected) => {
                        break;
                    }
                    Err(TryRecvError::Empty) => {
                        should_wait = true;
                    }
                }
                if is_inited && last_is_playing {
                    let now = inst.elapsed().as_secs_f64();
                    let pos = start_base_time + now;
                    let _ = app_clone.emit(
                        "on-audio-thread-event",
                        AudioThreadEvent::PlayPosition { position: pos },
                    );
                }
                if should_wait {
                    tokio::time::sleep(Duration::from_millis(16)).await;
                }
            }
        });

        Self {
            evt_sender,
            player,
            current_play_task_handle: None,
            volume: 0.5,
            playlist,
            playlist_inited: false,
            current_song: None,
            is_playing: false,
            current_audio_info: Arc::new(RwLock::new(AudioInfo::default())),
            fft_player,
            fft_has_data_sx,
            play_pos_sx,
            current_play_index: 0,
            play_task_sx: tokio::sync::mpsc::unbounded_channel().0, // Stub
            play_task_data: Arc::new(Mutex::new(AudioPlayerTaskData::default())),
        }
    }

    pub async fn emit(&self, data: AudioThreadEvent<T>) {
        let _ = self.evt_sender.send(data).await;
    }

    pub async fn process_message(&mut self, msg: AudioThreadMessage<T>) {
        match &msg {
            AudioThreadMessage::SetCookie { cookie, .. } => {
                info!("已设置 Cookie 头，长度为 {}", cookie.len());
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            AudioThreadMessage::SeekAudio {
                callback_id,
                position,
                ..
            } => {
                info!("正在跳转音乐到 {position}s");
                let _ = self.play_task_sx.send(AudioThreadMessage::SeekAudio {
                    callback_id: callback_id.to_owned(),
                    position: *position,
                });
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            AudioThreadMessage::ResumeAudio { callback_id, .. } => {
                self.is_playing = true;
                info!("开始继续播放歌曲！");
                let _ = self.play_task_sx.send(AudioThreadMessage::ResumeAudio {
                    callback_id: callback_id.to_owned(),
                });
                let _ = self.evt_sender.emit(
                    "on-audio-thread-event",
                    AudioThreadEvent::PlayStatus { is_playing: true },
                );
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            AudioThreadMessage::PauseAudio { callback_id, .. } => {
                self.is_playing = false;
                // 如果暂停播放设备的播放，恢复播放时会重新播放仍在播放环缓冲区的音频数据再次播放，会有不和谐感
                // 所以只暂停将数据传递给播放设备，让播放设备将缓冲区的数据完全耗尽
                // if self.player.stream().pause().is_err() {
                //     self.player = super::output::init_audio_player("");
                // }
                info!("播放已暂停！");
                let _ = self.play_task_sx.send(AudioThreadMessage::PauseAudio {
                    callback_id: callback_id.to_owned(),
                });
                let _ = self.evt_sender.emit(
                    "on-audio-thread-event",
                    AudioThreadEvent::PlayStatus { is_playing: false },
                );
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            AudioThreadMessage::ResumeOrPauseAudio { callback_id, .. } => {
                self.is_playing = !self.is_playing;
                if self.is_playing {
                    info!("开始继续播放歌曲！");
                    let _ = self.play_task_sx.send(AudioThreadMessage::ResumeAudio {
                        callback_id: callback_id.to_owned(),
                    });
                    let _ = self.evt_sender.emit(
                        "on-audio-thread-event",
                        AudioThreadEvent::PlayStatus { is_playing: true },
                    );
                } else {
                    info!("播放已暂停！");
                    let _ = self.play_task_sx.send(AudioThreadMessage::PauseAudio {
                        callback_id: callback_id.to_owned(),
                    });
                    // let _ = self.play_pos_sx.send(Some((false, self.play_position)));
                    let _ = self.evt_sender.emit(
                        "on-audio-thread-event",
                        AudioThreadEvent::PlayStatus { is_playing: false },
                    );
                }
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            AudioThreadMessage::PrevSong { .. } => {
                if self.playlist.is_empty() {
                    warn!("无法播放歌曲，尚未设置播放列表！");
                    return;
                }
                if self.current_play_index == 0 {
                    self.current_play_index = self.playlist.len() - 1;
                } else {
                    self.current_play_index -= 1;
                }
                self.current_song = self.playlist.get(self.current_play_index).cloned();

                self.is_playing = true;
                info!("播放上一首歌曲！");
                self.recreate_play_task();
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            AudioThreadMessage::NextSong { .. } => {
                self.is_playing = true;
                if self.playlist.is_empty() {
                    warn!("无法播放歌曲，尚未设置播放列表！");
                    return;
                }
                self.current_play_index = (self.current_play_index + 1) % self.playlist.len();
                self.current_song = self.playlist.get(self.current_play_index).cloned();
                info!("播放下一首歌曲！");
                self.recreate_play_task();
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            AudioThreadMessage::JumpToSong { song_index, .. } => {
                if self.playlist.is_empty() {
                    warn!("无法播放歌曲，尚未设置播放列表！");
                    return;
                }
                self.is_playing = true;
                self.current_play_index = *song_index;
                self.current_song = self.playlist.get(self.current_play_index).cloned();
                info!("播放第 {} 首歌曲！", *song_index + 1);
                self.recreate_play_task();
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            AudioThreadMessage::SetPlaylist { songs, .. } => {
                self.playlist_inited = true;
                songs.clone_into(&mut self.playlist);
                info!("已设置播放列表，歌曲数量为 {}", songs.len());
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            AudioThreadMessage::SyncStatus => {
                self.send_sync_status().await;
            }
            AudioThreadMessage::SetVolume { volume, .. } => {
                self.volume = volume.clamp(0., 1.);
                let _ = self.player.set_volume(self.volume).await;
                let _ = self.evt_sender.emit(
                    "on-audio-thread-event",
                    AudioThreadEvent::VolumeChanged {
                        volume: self.volume,
                    },
                );
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            AudioThreadMessage::SetVolumeRelative { volume, .. } => {
                self.volume += volume;
                self.volume = self.volume.clamp(0., 1.);
                let _ = self.player.set_volume(self.volume).await;
                let _ = self.evt_sender.emit(
                    "on-audio-thread-event",
                    AudioThreadEvent::VolumeChanged {
                        volume: self.volume,
                    },
                );
                msg.ret(&self.evt_sender, None::<()>).unwrap();
            }
            other => {
                warn!("未知的音频线程消息：{other:?}");
                other.ret(&self.evt_sender, None::<()>).unwrap()
            }
        }
    }

    async fn send_sync_status(&self) {
        let play_task_data = self.play_task_data.lock().await.clone();
        let audio_info = self.current_audio_info.read().await.clone();
        let _ = self.evt_sender.emit(
            "on-audio-thread-event",
            AudioThreadEvent::SyncStatus {
                music_id: self
                    .current_song
                    .as_ref()
                    .map(|x| x.get_id())
                    .unwrap_or_default(),
                is_playing: self.is_playing,
                duration: audio_info.duration,
                position: audio_info.position,
                volume: self.volume,
                load_position: 0.,
                playlist_inited: self.playlist_inited,
                playlist: self.playlist.to_owned(),
                quality: play_task_data.audio_quality,
            },
        );
    }

    pub fn recreate_play_task(&mut self) {
        if let Some(task) = self.current_play_task_handle.take() {
            task.abort();
        }
        if let Some(current_song) = self.current_song.clone() {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            self.play_task_sx = tx;
            let ctx = AudioPlayerTaskContext {
                app: self.evt_sender.clone(),
                audio_tx: self.player.clone(),
                play_rx: rx,
                fft_player: self.fft_player.clone(),
                fft_has_data_sx: self.fft_has_data_sx.clone(),
                play_pos_sx: self.play_pos_sx.clone(),
                current_audio_info: self.current_audio_info.clone(),
            };
            let task = tokio::task::spawn(Self::play_audio(ctx, current_song));
            self.current_play_task_handle = Some(task.abort_handle());
        } else {
            warn!("当前没有歌曲可以播放！");
        }
    }

    async fn play_audio(ctx: AudioPlayerTaskContext<T>, song_data: SongData<T>) -> anyhow::Result<()> {
        let app_clone = ctx.app.clone();
        if let Err(err) = {
            let music_id = song_data.get_id();
            let _ = ctx.app.emit(
                "on-audio-thread-event",
                AudioThreadEvent::LoadingAudio {
                    music_id: music_id.to_owned(),
                },
            );
            match song_data {
                SongData::Local { file_path, .. } => {
                    info!("正在播放本地音乐文件 {file_path}");
                    Self::play_audio_from_local(ctx, music_id, file_path).await
                }
                _ => {
                    // TODO: 自定义音乐来源
                    Ok(())
                }
            }
        } {
            error!("播放音频文件时出错：{err:?}");
            let _ = app_clone.emit(
                "on-audio-thread-event",
                AudioThreadEvent::LoadError {
                    error: format!("{err:?}"),
                },
            );
        }

        let _ = crate::audio::send_msg_to_audio_thread_inner(AudioThreadMessage::NextSong {
            callback_id: "".into(),
        });

        Ok(())
    }

    async fn play_audio_from_local(
        ctx: AudioPlayerTaskContext<T>,
        music_id: String,
        file_path: impl AsRef<std::path::Path> + std::fmt::Debug,
    ) -> anyhow::Result<()> {
        info!("正在打开本地音频文件：{file_path:?}");
        let source = std::fs::File::open(file_path.as_ref()).context("无法打开本地音频文件")?;

        Self::play_media_stream(ctx, music_id, source).await?;

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn play_media_stream(
        mut ctx: AudioPlayerTaskContext<T>,
        music_id: String,
        source: impl MediaSource + 'static,
    ) -> anyhow::Result<()> {
        let handle = tokio::runtime::Handle::current();
        let source_stream = handle
            .spawn_blocking(|| {
                MediaSourceStream::new(Box::new(source), MediaSourceStreamOptions::default())
            })
            .await?;
        let codecs = symphonia::default::get_codecs();
        let probe = symphonia::default::get_probe();
        let mut format_result = handle
            .spawn_blocking(|| {
                probe.format(
                    &Default::default(),
                    source_stream,
                    &Default::default(),
                    &Default::default(),
                )
            })
            .await?
            .context("无法解码正在加载的音频数据信息")?;
        if let Some(metadata) = format_result.metadata.get() {
            if let Some(rev) = metadata.current() {
                for v in rev.vendor_data() {
                    info!("音频文件的元数据：{} 大小 {}", v.ident, v.data.len());
                }
                for v in rev.visuals() {
                    info!(
                        "音频文件的视觉图数据：{:?} {:?} 大小 {}",
                        v.usage,
                        v.tags,
                        v.data.len()
                    );
                }
                for t in rev.tags() {
                    info!("音频文件的标签数据：{} {:?}", t.key, t.value);
                }
            }
        }
        let track = format_result
            .format
            .default_track()
            .context("无法解码正在加载的音频的默认音轨")?;
        let timebase = track.codec_params.time_base.unwrap_or_default();
        let mut decoder = codecs
            .make(&track.codec_params, &Default::default())
            .context("无法为当前音频文件选择解码器")?;
        let duration = timebase.calc_time(track.codec_params.n_frames.unwrap_or_default());
        let play_duration = duration.seconds as f64 + duration.frac;
        let mut current_audio_info = ctx.current_audio_info.write().await;
        current_audio_info.duration = play_duration;
        current_audio_info.position = 0.0;
        drop(current_audio_info);
        let audio_quality: AudioQuality = track.into();
        let _ = ctx.app.emit(
            "on-audio-thread-event",
            AudioThreadEvent::LoadAudio {
                music_id,
                duration: play_duration,
                quality: audio_quality.to_owned(),
            },
        );
        let _ = ctx.app.emit(
            "on-audio-thread-event",
            AudioThreadEvent::PlayStatus { is_playing: true },
        );
        let _ = ctx.app.emit(
            "on-audio-thread-event",
            AudioThreadEvent::SetDuration {
                duration: play_duration,
            },
        );

        info!("开始播放音频数据，时长为 {play_duration} 秒，音质为 {audio_quality:?}");

        let format_result = Arc::new(tokio::sync::Mutex::new(format_result));

        let mut is_playing = true;
        let mut last_play_pos = 0.0;
        ctx.play_pos_sx.send(Some((false, last_play_pos))).unwrap();
        let play_result = 'play_loop: loop {
            if is_playing {
                'recv_loop: loop {
                    match ctx.play_rx.try_recv() {
                        Ok(msg) => match msg {
                            AudioThreadMessage::SeekAudio { position, .. } => {
                                let format_result = Arc::clone(&format_result);
                                handle
                                    .spawn_blocking(move || {
                                        format_result.blocking_lock().format.seek(
                                            symphonia::core::formats::SeekMode::Coarse,
                                            symphonia::core::formats::SeekTo::Time {
                                                time: Time::new(position as _, position.fract()),
                                                track_id: None,
                                            },
                                        )
                                    })
                                    .await??;
                                ctx.play_pos_sx.send(Some((false, position))).unwrap();
                                ctx.current_audio_info.write().await.position = position;
                            }
                            AudioThreadMessage::PauseAudio { .. } => {
                                is_playing = false;
                                ctx.play_pos_sx.send(Some((false, last_play_pos))).unwrap();
                                continue 'play_loop;
                            }
                            _ => {}
                        },
                        Err(TryRecvError::Disconnected) => {
                            break 'play_loop Err(anyhow::anyhow!("已断开音频线程通道"))
                        }
                        Err(TryRecvError::Empty) => break 'recv_loop,
                    }
                }
                let format_result = Arc::clone(&format_result);
                let packet = match handle
                    .spawn_blocking(move || format_result.blocking_lock().format.next_packet())
                    .await?
                {
                    Ok(packet) => packet,
                    Err(DecodeError::IoError(err)) => match err.kind() {
                        ErrorKind::UnexpectedEof if err.to_string() == "end of stream" => {
                            break 'play_loop Ok(())
                        }
                        ErrorKind::WouldBlock => continue,
                        _ => {
                            break 'play_loop Err(anyhow::anyhow!("读取数据块发生 IO 错误: {err}"))
                        }
                    },
                    Err(err) => {
                        break 'play_loop Err(anyhow::anyhow!("读取数据块发生其他错误: {err}"))
                    }
                };
                match decoder.decode(&packet) {
                    Ok(buf) => {
                        let time = timebase.calc_time(packet.ts);
                        let play_position = time.seconds as f64 + time.frac;
                        last_play_pos = play_position;
                        ctx.current_audio_info.write().await.position = play_position;
                        if !ctx.app.webview_windows().is_empty() {
                            ctx.play_pos_sx.send(Some((true, play_position))).unwrap();
                            ctx.fft_player.lock().await.push_data(&buf);
                            let _ = ctx.fft_has_data_sx.send(());
                        }
                        ctx.audio_tx.write_ref(0, buf).await?;
                    }
                    Err(symphonia::core::errors::Error::DecodeError(err)) => {
                        warn!("解码数据块出错，跳过当前块: {}", err);
                    }
                    Err(err) => break Err(anyhow::anyhow!("解码出现其他错误: {err}")),
                }
            } else if let Some(msg) = ctx.play_rx.recv().await {
                match msg {
                    AudioThreadMessage::SeekAudio { position, .. } => {
                        let format_result = Arc::clone(&format_result);
                        handle
                            .spawn_blocking(move || {
                                format_result.blocking_lock().format.seek(
                                    symphonia::core::formats::SeekMode::Coarse,
                                    symphonia::core::formats::SeekTo::Time {
                                        time: Time::new(position as _, position.fract()),
                                        track_id: None,
                                    },
                                )
                            })
                            .await??;
                        ctx.play_pos_sx.send(Some((false, position))).unwrap();
                        ctx.current_audio_info.write().await.position = position;
                    }
                    AudioThreadMessage::ResumeAudio { .. } => {
                        is_playing = true;
                    }
                    _ => {}
                }
            }
        };

        if let Err(err) = play_result {
            error!("播放音频出错: {err:?}");
        }

        Ok(())
    }
}