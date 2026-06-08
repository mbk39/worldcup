"""WSGI entrypoint for production hosts (PythonAnywhere, Gunicorn, etc.).

PythonAnywhere: point its WSGI file at `from wsgi import application`.
Gunicorn/Render: start command `gunicorn wsgi:application`.
"""

from app import app as application

if __name__ == "__main__":
    application.run()
