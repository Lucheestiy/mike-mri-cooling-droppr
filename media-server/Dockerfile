FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN pip install flask requests

COPY app.py /app/

EXPOSE 5000

CMD ["python", "app.py"]