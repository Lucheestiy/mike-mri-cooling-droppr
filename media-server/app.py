#!/usr/bin/env python3
"""
Simple media server that extracts files from FileBrowser ZIP shares
and serves them individually for the gallery.
"""

import os
import zipfile
import io
import mimetypes
import time
from functools import lru_cache
from flask import Flask, send_file, jsonify, request, Response, stream_with_context
from urllib.parse import quote
import requests

app = Flask(__name__)

# FileBrowser API base URL
FILEBROWSER_API = "http://droppr-app:80/api/public/dl"
CACHE_DIR = "/tmp/droppr_cache"

# Ensure cache directory exists
os.makedirs(CACHE_DIR, exist_ok=True)

def get_cached_zip_path(share_hash):
    """Return the path to the cached ZIP file"""
    return os.path.join(CACHE_DIR, f"{share_hash}.zip")

def get_zip_content(share_hash):
    """Download ZIP file from FileBrowser or return cached version"""
    cache_path = get_cached_zip_path(share_hash)
    
    # Check if cache exists and is fresh (e.g., less than 1 hour old)
    if os.path.exists(cache_path):
        mtime = os.path.getmtime(cache_path)
        if time.time() - mtime < 3600:  # 1 hour cache
            return cache_path

    try:
        app.logger.info(f"Downloading ZIP for {share_hash}...")
        response = requests.get(f"{FILEBROWSER_API}/{share_hash}?download=1", timeout=60)
        response.raise_for_status()
        
        with open(cache_path, 'wb') as f:
            f.write(response.content)
            
        return cache_path
    except Exception as e:
        app.logger.error(f"Failed to get ZIP for {share_hash}: {e}")
        # If download fails but we have an old cache, return it as fallback
        if os.path.exists(cache_path):
            return cache_path
        return None

def get_file_from_zip(share_hash, filename):
    """Extract specific file from ZIP"""
    zip_path = get_zip_content(share_hash)
    if not zip_path:
        return None
    
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_file:
            # Find the file (it might be in a subdirectory)
            for zip_info in zip_file.infolist():
                if zip_info.filename.endswith(filename) and not zip_info.is_dir():
                    return zip_file.read(zip_info), zip_info.filename
        return None
    except Exception as e:
        app.logger.error(f"Failed to extract {filename} from {share_hash}: {e}")
        return None

@lru_cache(maxsize=100)
def list_files_in_zip_cached(share_hash, mtime_check):
    """List all files in the ZIP, cached by share_hash and mtime of the ZIP"""
    zip_path = get_zip_content(share_hash)
    if not zip_path:
        return []
    
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_file:
            files = []
            for zip_info in zip_file.infolist():
                if not zip_info.is_dir() and not zip_info.filename.startswith('.') and not '__MACOSX' in zip_info.filename:
                    # Get just the filename without path
                    filename = os.path.basename(zip_info.filename)
                    if filename:  # Skip empty names
                        extension = filename.split('.')[-1].lower() if '.' in filename else ''
                        
                        # Determine file type
                        image_exts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']
                        video_exts = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']
                        
                        if extension in image_exts:
                            file_type = 'image'
                        elif extension in video_exts:
                            file_type = 'video'
                        else:
                            file_type = 'file'
                        
                        files.append({
                            'name': filename,
                            'type': file_type,
                            'extension': extension,
                            'size': zip_info.file_size
                        })
            return files
    except Exception as e:
        app.logger.error(f"Failed to list files in {share_hash}: {e}")
        return []

@app.route('/api/share/<share_hash>/files')
def list_share_files(share_hash):
    """API endpoint to list files in a share"""
    cache_path = get_cached_zip_path(share_hash)
    mtime = 0
    if os.path.exists(cache_path):
        mtime = os.path.getmtime(cache_path)
    
    files = list_files_in_zip_cached(share_hash, mtime)
    return jsonify(files)

@app.route('/api/share/<share_hash>/file/<filename>')
def serve_file(share_hash, filename):
    """Serve individual file from ZIP"""
    result = get_file_from_zip(share_hash, filename)
    if not result:
        return "File not found", 404
    
    file_data, zip_path = result
    
    # Determine MIME type
    mime_type, _ = mimetypes.guess_type(filename)
    if not mime_type:
        mime_type = 'application/octet-stream'
    
    # Create in-memory file
    file_obj = io.BytesIO(file_data)
    
    # Determine disposition based on file type
    if mime_type.startswith(('image/', 'video/')):
        disposition = 'inline'
    else:
        disposition = 'attachment'
    
    return send_file(
        file_obj, 
        mimetype=mime_type,
        as_attachment=(disposition == 'attachment'),
        download_name=filename
    )

@app.route('/api/share/<share_hash>/download')
def download_all(share_hash):
    """Proxy the full ZIP download from FileBrowser"""
    zip_path = get_zip_content(share_hash)
    if zip_path and os.path.exists(zip_path):
        return send_file(zip_path, as_attachment=True, download_name=f"share_{share_hash}.zip")

    try:
        req_url = f"{FILEBROWSER_API}/{share_hash}?download=1"
        req = requests.get(req_url, stream=True, timeout=30)
        req.raise_for_status()

        return Response(stream_with_context(req.iter_content(chunk_size=8192)), 
                        content_type=req.headers.get('Content-Type'),
                        headers={
                            'Content-Disposition': f'attachment; filename="share_{share_hash}.zip"'
                        })
    except Exception as e:
        app.logger.error(f"Failed to download ZIP for {share_hash}: {e}")
        return "Failed to download share", 500

@app.route('/health')
def health_check():
    """Health check endpoint"""
    return jsonify({"status": "healthy"})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)