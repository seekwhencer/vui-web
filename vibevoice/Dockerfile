FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-runtime

WORKDIR /app

# System-Abhängigkeiten für Audio-Verarbeitung
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Notwendige Python-Pakete (PyTorch ist im Base-Image bereits enthalten)
RUN pip install --no-cache-dir \
    transformers \
    accelerate \
    soundfile \
    librosa \
    fastapi \
    uvicorn \
    python-multipart

COPY server.py /app/server.py

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "5000"]