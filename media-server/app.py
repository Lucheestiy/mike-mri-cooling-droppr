#!/usr/bin/env python3
"""
Simple media server that extracts files from FileBrowser ZIP shares
and serves them individually for the gallery.
"""

import os
import zipfile
import io
import mimetypes
from flask import Flask, send_file, jsonify, request
from urllib.parse import quote
import requests

app = Flask(__name__)

# FileBrowser API base URL
FILEBROWSER_API = "http://droppr-app:80/api/public/dl"

def get_zip_content(share_hash):
    """Download ZIP file from FileBrowser"""
    try:
        response = requests.get(f"{FILEBROWSER_API}/{share_hash}?download=1", timeout=30)
        response.raise_for_status()
        return io.BytesIO(response.content)
    except Exception as e:
        app.logger.error(f"Failed to get ZIP for {share_hash}: {e}")
        return None

def get_file_from_zip(share_hash, filename):
    """Extract specific file from ZIP"""
    zip_content = get_zip_content(share_hash)
    if not zip_content:
        return None
    
    try:
        with zipfile.ZipFile(zip_content, 'r') as zip_file:
            # Find the file (it might be in a subdirectory)
            for zip_info in zip_file.infolist():
                if zip_info.filename.endswith(filename) and not zip_info.is_dir():
                    return zip_file.read(zip_info), zip_info.filename
        return None
    except Exception as e:
        app.logger.error(f"Failed to extract {filename} from {share_hash}: {e}")
        return None

def list_files_in_zip(share_hash):
    """List all files in the ZIP"""
    zip_content = get_zip_content(share_hash)
    if not zip_content:
        return []
    
    try:
        with zipfile.ZipFile(zip_content, 'r') as zip_file:
            files = []
            for zip_info in zip_file.infolist():
                if not zip_info.is_dir() and not zip_info.filename.startswith('.'):
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
    files = list_files_in_zip(share_hash)
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

@app.route('/health')
def health_check():
    """Health check endpoint"""
    return jsonify({"status": "healthy"})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)