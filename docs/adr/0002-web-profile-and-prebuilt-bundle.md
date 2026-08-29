# Target the Web profile and distribute a prebuilt bundle

v0.1 will support the DSH `web` profile and ship as an out-of-tree `dsh.bundle` with public source on GitHub and prebuilt npm artifacts, while other profiles and source-building installs remain outside the supported user path. Because Harness is still a developer preview, releases declare and test an explicit DSH compatibility range and fail clearly outside it instead of carrying speculative compatibility branches or silently interpreting incompatible stored data.
