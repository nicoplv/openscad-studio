use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use tauri::{ipc::InvokeBody, Manager, WebviewWindow};
use tauri_plugin_fs::FsExt;
use uuid::Uuid;

#[tauri::command]
pub fn write_project_archive(
    window: WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let InvokeBody::Raw(payload) = request.body() else {
        return Err("Expected a binary project archive.".into());
    };
    let mut parts = payload.splitn(2, |byte| *byte == 0);
    let path = parts
        .next()
        .and_then(|value| std::str::from_utf8(value).ok())
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .ok_or("Invalid project destination.")?;
    let archive = parts.next().ok_or("Missing project archive.")?;
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("oscadstudio"))
    {
        return Err("Choose a destination ending in .oscadstudio.".into());
    }
    let parent = path.parent().ok_or("Invalid project destination.")?;
    let directory = parent.canonicalize().map_err(|err| err.to_string())?;
    let home = window
        .path()
        .home_dir()
        .ok()
        .and_then(|path| path.canonicalize().ok());
    if !home.is_some_and(|home| directory.starts_with(home)) && !window.fs_scope().is_allowed(path)
    {
        return Err("Project destination needs permission.".into());
    }

    let temporary = directory.join(format!(".{}.oscadstudio.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|err| err.to_string())?;
    let result = file.write_all(archive).and_then(|()| file.sync_all());
    drop(file);
    let destination = directory.join(path.file_name().ok_or("Invalid project destination.")?);
    let result = result.and_then(|()| fs::rename(&temporary, destination));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|err| err.to_string())
}
