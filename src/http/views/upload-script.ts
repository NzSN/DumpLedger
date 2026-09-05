export const uploadScript = `"use strict";
const input = document.getElementById("dump-file");
const zone = document.getElementById("drop-zone");
const button = document.getElementById("upload-button");
const fileName = document.getElementById("file-name");
const fileSize = document.getElementById("file-size");
const progress = document.getElementById("upload-progress");
const progressBar = document.getElementById("upload-progress-bar");
const status = document.getElementById("upload-status");
let selectedFile;

function bytes(value) {
  if (value < 1024) return value + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = -1;
  do { size /= 1024; unit += 1; } while (size >= 1024 && unit < units.length - 1);
  return size.toFixed(size >= 10 ? 1 : 2) + " " + units[unit];
}

function choose(file) {
  if (!file) return;
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = bytes(file.size);
  zone.classList.add("has-file");
  button.disabled = false;
  status.textContent = "Ready to upload";
  status.dataset.tone = "neutral";
}

input.addEventListener("change", () => choose(input.files && input.files[0]));
["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, (event) => {
  event.preventDefault();
  zone.classList.add("is-dragging");
}));
["dragleave", "drop"].forEach((name) => zone.addEventListener(name, (event) => {
  event.preventDefault();
  zone.classList.remove("is-dragging");
}));
zone.addEventListener("drop", (event) => choose(event.dataTransfer && event.dataTransfer.files[0]));

button.addEventListener("click", () => {
  if (!selectedFile || button.disabled) return;
  button.disabled = true;
  input.disabled = true;
  progress.hidden = false;
  status.textContent = "Uploading securely…";
  status.dataset.tone = "active";

  const request = new XMLHttpRequest();
  request.open("POST", location.pathname);
  request.setRequestHeader("Content-Type", "application/octet-stream");
  request.setRequestHeader("X-Dump-Filename", selectedFile.name);
  request.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.max(0, Math.min(100, Math.round(event.loaded / event.total * 100)));
    progressBar.style.width = percent + "%";
    progress.setAttribute("aria-valuenow", String(percent));
    status.textContent = "Uploading securely… " + percent + "%";
  });
  request.addEventListener("load", () => {
    let body = {};
    try { body = JSON.parse(request.responseText); } catch {}
    if (request.status >= 200 && request.status < 300) {
      progressBar.style.width = "100%";
      progress.setAttribute("aria-valuenow", "100");
      const phase = body.phase || body.processing || "received";
      status.textContent = "Upload received · " + String(phase).replaceAll("-", " ");
      status.dataset.tone = phase === "rejected" ? "warning" : "success";
      zone.classList.add("is-complete");
      return;
    }
    status.textContent = "Upload failed · " + (body.error || "please request a new link");
    status.dataset.tone = "error";
  });
  request.addEventListener("error", () => {
    status.textContent = "Network error · this one-time link may now be consumed";
    status.dataset.tone = "error";
  });
  request.send(selectedFile);
});`;
