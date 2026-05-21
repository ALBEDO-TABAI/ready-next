---
name: image-reverse-descriptor
description: Generate concise reusable prompt-style descriptors from one webpage image. Use when a user asks for image reverse description, visual prompt extraction, or keyword material from a selected image.
---

# Image Reverse Descriptor

Turn the image itself into reusable description material.

## Output

Write one concise Chinese paragraph. Focus on:

- 主体与动作
- 场景与环境
- 构图、视角、景别
- 光线、色彩、材质
- 风格、媒介、质感
- 可直接复用的关键词

## Rules

- Describe only what is visible in the image.
- Do not infer hidden page context, author intent, brand claims, or identity.
- Prefer concrete visual words over generic praise.
- Do not output JSON or markdown headings.
- Keep the result compact enough to fit a floating panel.
