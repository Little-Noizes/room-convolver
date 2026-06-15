# Privacy Statement

## Audio processing

Audio files uploaded to Room Convolver are processed entirely within your browser using JavaScript running on your device. No audio data, file contents, filenames, or metadata are sent to any server.

You can verify this:

1. Open your browser's developer tools (F12 or Cmd+Option+I)
2. Go to the **Network** tab
3. Upload a file and run a render
4. Observe that no network requests are made containing audio data

## Analytics

This application does not include analytics, tracking pixels, session recording, or any third-party scripts that capture usage data.

## Local storage

The application does not write to `localStorage`, `sessionStorage`, `IndexedDB`, or cookies. When you close or refresh the page, all uploaded files and render results are discarded.

## Filenames

Filenames are displayed in the interface for identification only. They are sanitised before display to remove potentially unsafe characters. Filenames are recorded in the processing report JSON, which is stored locally and only leaves your device if you explicitly download and share it.

## CDN and asset delivery

Static application assets (JavaScript, CSS) are served from GitHub Pages or your chosen host. These are standard web assets with no audio content. Your browser may cache them locally.

## Third-party dependencies

All third-party code (React, Vite) runs locally in your browser after the initial page load. No third-party audio processing services are used.

## Changes

This document describes the current v0.1.0 release. Any future changes to data handling will be documented here before release.
