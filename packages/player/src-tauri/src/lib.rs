use crate::server::AMLLWebSocketServer;
use base64::prelude::*;
use serde::*;
use std::{fs::File, net::SocketAddr, sync::Mutex};
use symphonia::core::{
    io::{MediaSourceStream, MediaSourceStreamOptions},
    meta::StandardTagKey,
};
use tauri::{Manager, State};
use tracing::*;

mod player;
mod server;

// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
#[tauri::command]
fn ws_reopen_connection(addr: &str, ws: State<Mutex<AMLLWebSocketServer>>) {
    ws.lock().unwrap().reopen(addr.to_string());
}

#[tauri::command]
fn ws_get_connections(ws: State<Mutex<AMLLWebSocketServer>>) -> Vec<SocketAddr> {
    ws.lock().unwrap().get_connections()
}

#[tauri::command]
fn ws_boardcast_message(ws: State<'_, Mutex<AMLLWebSocketServer>>, data: ws_protocol::Body) {
    let ws = ws.clone();
    tauri::async_runtime::block_on(ws.lock().unwrap().boardcast_message(data));
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicInfo {
    pub name: String,
    pub artist: String,
    pub album: String,
    pub lyric: String,
    pub cover: String,
    pub duration: f64,
}

#[tauri::command]
fn read_local_music_metadata(file_path: String) -> Result<MusicInfo, String> {
    let file = File::open(file_path).map_err(|e| e.to_string())?;
    let probe = symphonia::default::get_probe();
    let mut format_result = probe
        .format(
            &Default::default(),
            MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default()),
            &Default::default(),
            &Default::default(),
        )
        .map_err(|e| e.to_string())?;

    let mut new_audio_info = MusicInfo::default();
    let mut metadata = format_result.format.metadata();
    metadata.skip_to_latest();

    if let Some(metadata) = metadata.skip_to_latest() {
        for tag in metadata.tags() {
            match tag.std_key {
                Some(StandardTagKey::TrackTitle) => {
                    new_audio_info.name = tag.value.to_string();
                }
                Some(StandardTagKey::Artist) => {
                    new_audio_info.artist = tag.value.to_string();
                }
                Some(StandardTagKey::Album) => {
                    new_audio_info.album = tag.value.to_string();
                }
                Some(StandardTagKey::Lyrics) => {
                    new_audio_info.lyric = tag.value.to_string();
                }
                Some(_) | None => {}
            }
        }
        for visual in metadata.visuals() {
            if visual.usage == Some(symphonia::core::meta::StandardVisualKey::FrontCover) {
                new_audio_info.cover =
                    BASE64_STANDARD.encode(&visual.data);
            }
        }
    }

    let track = format_result
        .format
        .default_track()
        .ok_or_else(|| "无法解码正在加载的音频的默认音轨".to_string())?;
    let timebase = track.codec_params.time_base.unwrap_or_default();
    let duration = timebase.calc_time(track.codec_params.n_frames.unwrap_or_default());
    let play_duration = duration.seconds as f64 + duration.frac;
    new_audio_info.duration = play_duration;

    Ok(new_audio_info)
}

fn init_logging() {
    #[cfg(not(debug_assertions))]
    {
        let log_file = std::fs::File::create("amll-player.log");
        if let Ok(log_file) = log_file {
            tracing_subscriber::fmt()
                .map_writer(move |_| log_file)
                .with_thread_names(true)
                .with_ansi(false)
                .with_timer(tracing_subscriber::fmt::time::uptime())
                .init();
        } else {
            tracing_subscriber::fmt()
                .with_thread_names(true)
                .with_timer(tracing_subscriber::fmt::time::uptime())
                .init();
        }
    }
    #[cfg(debug_assertions)]
    {
        tracing_subscriber::fmt()
            .with_env_filter("amll_player=trace")
            .with_thread_names(true)
            .with_timer(tracing_subscriber::fmt::time::uptime())
            .init();
    }
    std::panic::set_hook(Box::new(move |info| {
        error!("Fatal error occurred! AMLL Player will exit now.");
        error!("Error:");
        error!("{info:#?}");
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    info!("AMLL Player is starting!");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ws_reopen_connection,
            ws_get_connections,
            ws_boardcast_message,
            player::local_player_send_msg,
            read_local_music_metadata,
        ])
        .setup(|app| {
            player::init_local_player(app.handle().clone());
            app.manage(Mutex::new(AMLLWebSocketServer::new(app.handle().clone())));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}