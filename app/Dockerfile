FROM alpine:latest

# Install dependencies including ffmpeg for thumbnails
RUN apk add --no-cache curl ffmpeg bash ca-certificates mailcap

# Install FileBrowser
RUN curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | bash

# Setup directories
RUN mkdir -p /srv /config /database /defaults

# Copy init script
COPY init.sh /init.sh
RUN chmod +x /init.sh

# Expose port
EXPOSE 80

# Define volumes
VOLUME /srv /config /database

# Set entrypoint
ENTRYPOINT ["/init.sh"]
