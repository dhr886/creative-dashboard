#!/bin/bash
cd "$(dirname "$0")"

echo "========================================="
echo "  素材看板 - 推送更新到 GitHub"
echo "========================================="
echo ""

git add dashboard.html shared-data.json 2>/dev/null
git add -A

if git diff --cached --quiet 2>/dev/null; then
  echo "没有新的更改需要推送。"
  echo ""
  read -p "按回车键关闭..."
  exit 0
fi

echo "检测到以下更改："
git diff --cached --stat
echo ""

git commit -m "更新数据 $(date '+%Y-%m-%d %H:%M')"
git push origin main

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ 推送成功！"
  echo "别人刷新页面即可看到最新数据。"
  echo "网址: https://dhr886.github.io/creative-dashboard/dashboard.html"
else
  echo ""
  echo "❌ 推送失败，请检查网络或 GitHub 登录状态。"
fi

echo ""
read -p "按回车键关闭..."
