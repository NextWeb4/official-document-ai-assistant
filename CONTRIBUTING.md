# Contributing Guide

Thank you for contributing to HaoXiang Document Assistant.

## Development Setup

1. Install Python 3.12+ and Node.js 20+.
2. Install backend dependencies with `python -m pip install -r backend/requirements.txt`.
3. Install frontend dependencies with `npm --prefix frontend install`.
4. Start the Electron development app with `npm --prefix frontend run electron:dev`.

## Required Checks

- Backend and document changes: `pytest tests/ -q`
- Frontend lint: `npm --prefix frontend run lint`
- Frontend build: `npm --prefix frontend run build`
- Electron type check: `npx --prefix frontend tsc -p tsconfig.electron.json --noEmit`

## Code Style

- Follow the existing typed Python and Pydantic patterns; no backend formatter is configured.
- Keep TypeScript strict and compatible with the existing ESLint flat configuration.
- Keep document parsing, rule evaluation, and generation in backend core modules rather than React pages or API routes.
- Do not commit runtime data, credentials, build output, release assets, or third-party font binaries.

## Pull Requests

Use a focused branch, include tests for behavioral changes, and describe verification results in the pull request.
