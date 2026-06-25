// src/services/videoService.ts

import fs from "fs";
import path from "path";
import { Upload } from "@aws-sdk/lib-storage";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { s3 } from "../config/b2";
import pool from "../db";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
// @ts-ignore
import ffprobeStatic from "ffprobe-static";

// ✅ Set ffmpeg + ffprobe
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}
if (ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

export const processingProgress = new Map<string, number>();

export const processVideoAsync = async (
  videoId: string,
  file: Express.Multer.File
) => {
  console.log(`\n================ VIDEO PROCESS START ================`);
  console.log(`[INIT] Video ID: ${videoId}`);
  console.log(`[INIT] File path: ${file.path}`);
  console.log(`[INIT] File size: ${file.size}`);
  console.log(`[INIT] Mime: ${file.mimetype}`);

  const outputDir = `tmp/${videoId}`;
  fs.mkdirSync(outputDir, { recursive: true });

  const bucketName = process.env.B2_BUCKET_NAME!;

  try {
    // 🎬 STEP 1: HLS GENERATION
    console.log(`[STEP 1] Starting FFmpeg HLS conversion...`);

    await new Promise((resolve, reject) => {
      ffmpeg(file.path)
        .outputOptions([
          "-preset veryfast",
          "-g 48",
          "-sc_threshold 0",
          "-map 0:v:0",
          "-map 0:a:0?",
          "-b:v:0 1500k",
          "-s:v:0 1280x720",
          "-f hls",
          "-hls_time 6",
          "-hls_playlist_type vod",
          "-hls_segment_filename",
          `${outputDir}/seg_%03d.ts`,
        ])
        .output(`${outputDir}/index.m3u8`)
        .on("start", (cmd) => {
          console.log(`[FFMPEG] Command: ${cmd}`);
        })
        .on("progress", (progress) => {
          console.log(`[FFMPEG] Processing: ${progress.percent?.toFixed(2)}%`);
          if (progress.percent) {
            processingProgress.set(videoId, Math.min(99, Math.round(progress.percent)));
          }
        })
        .on("end", () => {
          console.log(`[STEP 1] HLS conversion complete`);
          resolve(true);
        })
        .on("error", (err) => {
          console.error(`[STEP 1 ERROR] FFmpeg failed`, err);
          reject(err);
        })
        .run();
    });

    // ✅ Check output
    console.log(`[CHECK] Verifying HLS output directory...`);

    if (!fs.existsSync(outputDir)) {
      throw new Error("HLS output directory missing");
    }

    const files = fs.readdirSync(outputDir);
    console.log(`[CHECK] Files generated:`, files);

    if (!files.length) {
      throw new Error("No HLS files generated");
    }

    // ☁️ STEP 2: Upload HLS
    console.log(`[STEP 2] Uploading HLS files to B2...`);

    await Promise.all(
      files.map(async (fileName) => {
        const filePath = path.join(outputDir, fileName);

        console.log(`[UPLOAD] Uploading: ${fileName}`);

        const upload = new Upload({
          client: s3,
          params: {
            Bucket: bucketName,
            Key: `videos/${videoId}/${fileName}`,
            Body: fs.createReadStream(filePath),
            ContentType: fileName.endsWith(".m3u8")
              ? "application/vnd.apple.mpegurl"
              : "video/MP2T",
          },
        });

        await upload.done();

        console.log(`[UPLOAD DONE] ${fileName}`);
      })
    );

    console.log(`[STEP 2] All HLS files uploaded`);

    // 📦 STEP 3: Upload original
    console.log(`[STEP 3] Uploading original video...`);

    const originalUpload = new Upload({
      client: s3,
      params: {
        Bucket: bucketName,
        Key: `raw/${videoId}/video.mp4`,
        Body: fs.createReadStream(file.path),
        ContentType: "video/mp4",
      },
    });

    await originalUpload.done();

    console.log(`[STEP 3] Original video uploaded`);

    // 🖼️ STEP 4: Thumbnail
    console.log(`[STEP 4] Generating thumbnail...`);

    const thumbPath = `${outputDir}/thumb.png`;

    await new Promise((resolve, reject) => {
      ffmpeg(file.path)
        .screenshots({
          count: 1,
          filename: "thumb.png",
          folder: outputDir,
        })
        .on("end", resolve)
        .on("error", reject);
    });

    if (fs.existsSync(thumbPath)) {
      console.log(`[STEP 4] Uploading thumbnail...`);

      const thumbUpload = new Upload({
        client: s3,
        params: {
          Bucket: bucketName,
          Key: `videos/${videoId}/thumb.png`,
          Body: fs.createReadStream(thumbPath),
          ContentType: "image/png",
        },
      });

      await thumbUpload.done();

      console.log(`[STEP 4] Thumbnail uploaded`);
    } else {
      console.warn(`[STEP 4 WARNING] Thumbnail not found`);
    }

    // 🌍 STEP 5: Build URLs
    console.log(`[STEP 5] Building URLs...`);

    const base =
      process.env.CLOUDFLARE_DOMAIN ||
      `https://f000.backblazeb2.com/file/${bucketName}`;
    const hlsUrl = `${base}/videos/${videoId}/index.m3u8`;
    const videoUrl = `${base}/raw/${videoId}/video.mp4`;
    const thumbnailUrl = `${base}/videos/${videoId}/thumb.png`;

    console.log(`[URLS] HLS: ${hlsUrl}`);
    console.log(`[URLS] Video: ${videoUrl}`);
    console.log(`[URLS] Thumbnail: ${thumbnailUrl}`);

    // 🗄️ STEP 6: DB Update
    console.log(`[STEP 6] Updating database...`);

    await pool.query(
      `UPDATE "Video"
       SET status = $1,
           hls_url = $2,
           video_url = $3,
           thumbnail_url = $4,
           updated_at = NOW()
       WHERE id = $5`,
      ["READY", hlsUrl, videoUrl, thumbnailUrl, videoId]
    );

    console.log(`[STEP 6] Database updated successfully`);

    // 🧹 STEP 7: Cleanup
    console.log(`[STEP 7] Cleaning up temp files...`);

    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.unlinkSync(file.path);

    processingProgress.delete(videoId);
    console.log(`[SUCCESS] Video ${videoId} is READY`);
    console.log(`================ VIDEO PROCESS END =================\n`);

  } catch (error) {
    console.error(`\n❌❌❌ VIDEO PROCESS FAILED ❌❌❌`);
    console.error(`[ERROR] Video ID: ${videoId}`);
    console.error(`[ERROR] Details:`, error);

    await pool.query(
      `UPDATE "Video"
       SET status = $1, updated_at = NOW()
       WHERE id = $2`,
      ["FAILED", videoId]
    );

    // Cleanup
    console.log(`[CLEANUP] Cleaning after failure...`);
    fs.rmSync(outputDir, { recursive: true, force: true });

    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    processingProgress.delete(videoId);
    console.log(`================ FAILURE END =================\n`);
  }
};

export const deleteVideoFilesAsync = async (videoId: string) => {
  console.log(`\n================ B2 DELETE PROCESS START ================`);
  console.log(`[INIT] Video ID to delete: ${videoId}`);

  const bucketName = process.env.B2_BUCKET_NAME!;

  try {
    const prefixes = [`videos/${videoId}/`, `raw/${videoId}/`];

    for (const prefix of prefixes) {
      console.log(`[B2 DELETE] Listing objects with prefix: ${prefix}`);
      let continuationToken: string | undefined = undefined;

      do {
        const listCmd: any = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });

        const listRes: any = await s3.send(listCmd);

        if (listRes.Contents && listRes.Contents.length > 0) {
          console.log(`[B2 DELETE] Found ${listRes.Contents.length} objects to delete in ${prefix}`);
          
          const deleteCmd: any = new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: listRes.Contents.map((c: any) => ({ Key: c.Key })),
            },
          });

          await s3.send(deleteCmd);
          console.log(`[B2 DELETE] Deleted ${listRes.Contents.length} objects`);
        } else {
          console.log(`[B2 DELETE] No objects found for prefix: ${prefix}`);
        }

        continuationToken = listRes.NextContinuationToken;
      } while (continuationToken);
    }

    console.log(`[SUCCESS] B2 files for video ${videoId} deleted successfully`);
  } catch (error) {
    console.error(`[ERROR] Failed to delete B2 files for video ${videoId}:`, error);
  } finally {
    console.log(`================ B2 DELETE PROCESS END =================\n`);
  }
};