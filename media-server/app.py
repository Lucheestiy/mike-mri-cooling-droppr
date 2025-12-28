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
import shutil
import fcntl
import json
from flask import Flask, send_file, jsonify, request, Response, stream_with_context, send_from_directory
import requests

app = Flask(__name__)

# FileBrowser API base URL
FILEBROWSER_API = "http://droppr-app:80/api/public/dl"
CACHE_DIR = "/tmp/droppr_cache"
EXTRACT_ROOT = os.path.join(CACHE_DIR, "extracted")

# Ensure cache directory exists
os.makedirs(EXTRACT_ROOT, exist_ok=True)

def acquire_lock(lock_path):
    """Acquire a file lock for synchronization"""
    lock_file = open(lock_path, 'w')
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        return lock_file
    except IOError:
        return None

def release_lock(lock_file):
    """Release the file lock"""
    if lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_UN)
        lock_file.close()

def find_file_in_dir(root_dir, target_filename):
    """Recursively find a file in the directory structure"""
    for root, dirs, files in os.walk(root_dir):
        if target_filename in files:
            return os.path.join(root, target_filename)
    return None

def generate_metadata(share_dir):
    """Generate metadata.json for the share to avoid re-scanning"""
    file_list = []
    
    for root, dirs, files in os.walk(share_dir):
        for filename in files:
            if filename.startswith('.') or filename == 'metadata.json' or '__MACOSX' in root:
                continue
                
            full_path = os.path.join(root, filename)
            rel_path = os.path.relpath(full_path, share_dir)
            
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
            
            file_list.append({
                'name': filename,
                'path': rel_path,
                'type': file_type,
                'extension': extension,
                'size': os.path.getsize(full_path)
            })
            
    # Save to disk
    try:
        with open(os.path.join(share_dir, 'metadata.json'), 'w') as f:
            json.dump(file_list, f)
    except Exception as e:
        app.logger.error(f"Failed to save metadata: {e}")
        
    return file_list

def ensure_share_extracted(share_hash):
    """
    Ensures the share ZIP is downloaded and extracted.
    Returns the path to the extracted directory or None on failure.
    """
    share_dir = os.path.join(EXTRACT_ROOT, share_hash)
    lock_path = os.path.join(CACHE_DIR, f"{share_hash}.lock")
    
    # Check if exists and is fresh (less than 1 hour old)
    if os.path.exists(share_dir):
        mtime = os.path.getmtime(share_dir)
        if time.time() - mtime < 3600:
            return share_dir
        # Expired, clean up
        shutil.rmtree(share_dir, ignore_errors=True)

    # Acquire lock to prevent concurrent downloads/extractions
    lock = acquire_lock(lock_path)
    try:
        # Double check after acquiring lock
        if os.path.exists(share_dir):
            return share_dir

        app.logger.info(f"Downloading and extracting ZIP for {share_hash}...")
        
        # Download ZIP
        zip_path = os.path.join(CACHE_DIR, f"{share_hash}.temp.zip")
        try:
            response = requests.get(f"{FILEBROWSER_API}/{share_hash}?download=1", timeout=120)
            response.raise_for_status()
            
            with open(zip_path, 'wb') as f:
                f.write(response.content)
            
            # Extract
            os.makedirs(share_dir, exist_ok=True)
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(share_dir)
            
            # Generate Metadata Cache
            generate_metadata(share_dir)

            # Cleanup ZIP
            os.remove(zip_path)
            
            return share_dir
            
        except Exception as e:
            app.logger.error(f"Failed to process share {share_hash}: {e}")
            shutil.rmtree(share_dir, ignore_errors=True) # Cleanup partial
            if os.path.exists(zip_path):
                os.remove(zip_path)
            return None
            
    finally:
        release_lock(lock)

@app.route('/api/share/<share_hash>/files')
def list_share_files(share_hash):
    """API endpoint to list files in a share"""
    share_dir = ensure_share_extracted(share_hash)
    if not share_dir:
        return jsonify({"error": "Failed to load share"}), 500

    # Try to read cached metadata
    metadata_path = os.path.join(share_dir, 'metadata.json')
    if os.path.exists(metadata_path):
        try:
            with open(metadata_path, 'r') as f:
                return jsonify(json.load(f))
        except Exception:
            pass # Fallback to manual scan if cache corrupt
            
    # Fallback (or first time if generation failed)
    return jsonify(generate_metadata(share_dir))

@app.route('/api/share/<share_hash>/file/<path:filename>')
def serve_file(share_hash, filename):
    """Serve individual file from extracted directory"""
    share_dir = os.path.join(EXTRACT_ROOT, share_hash)
    if not os.path.exists(share_dir):
        # Try to restore if missing (e.g. restart)
        share_dir = ensure_share_extracted(share_hash)
        if not share_dir:
            return "Share not found", 404

    # Security: Ensure we don't traverse up
    if '..' in filename:
         return "Invalid filename", 400

    # Try direct path first
    full_path = os.path.join(share_dir, filename)
    if os.path.isfile(full_path):
         return send_from_directory(share_dir, filename)
         
    # Fallback: Search for the file
    found_path = find_file_in_dir(share_dir, filename)
    if found_path:
        # Serve relative to share_dir
        rel_path = os.path.relpath(found_path, share_dir)
        return send_from_directory(share_dir, rel_path)

    return "File not found", 404

@app.route('/api/share/<share_hash>/download')
def download_all(share_hash):
    """Proxy the full ZIP download from FileBrowser"""
    try:
        req_url = f"{FILEBROWSER_API}/{share_hash}?download=1"
        req = requests.get(req_url, stream=True, timeout=120)
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