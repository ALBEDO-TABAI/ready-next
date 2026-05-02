# VEA e2e Fixtures

`sample-video.mp4` is a generated 30 second black H.264 video used by the opt-in VEA child-run e2e.

Regenerate it from this directory with:

```bash
ffmpeg -y -f lavfi -i color=black:s=640x360:d=30 -c:v libx264 -pix_fmt yuv420p sample-video.mp4
```

Coverage boundary: this fixture replaces network download / yt-dlp so the e2e can prove the Ready child-run path reaches the real VEA driver, PySceneDetect, and ffmpeg scene output. It does not prove full AI visual scoring or final report quality; the e2e runtime short-circuits after the real materials stage.
