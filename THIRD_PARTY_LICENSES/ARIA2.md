# aria2 download engine

Windows builds bundle the unmodified official aria2 1.37.0 win-64bit-build1 executable as a separate subprocess.

- Project and source: https://github.com/aria2/aria2/tree/release-1.37.0
- Exact corresponding release source: https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.xz
- Binary: https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip
- Archive SHA-256: `67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288`
- License: GNU GPL version 2 or later with the OpenSSL linking exception documented in the release.

The bundle includes the upstream COPYING, AUTHORS, LICENSE.OpenSSL, README.mingw and corresponding aria2-1.37.0.tar.xz source beside aria2c.exe. Source archive SHA-256: `60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b`. No changes are made to aria2 itself.

The application invokes aria2 without a shell or RPC service. Its HTTP requests go through a per-download loopback endpoint that only serves the selected output URL through the application's existing network session. API keys are never passed to the subprocess.
