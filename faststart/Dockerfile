FROM jrottenberg/ffmpeg:6.1-alpine

RUN apk add --no-cache inotify-tools python3

COPY faststart_watch.sh /app/faststart_watch.sh
COPY faststart.py /app/faststart.py

RUN chmod +x /app/faststart_watch.sh

ENTRYPOINT ["/app/faststart_watch.sh"]
