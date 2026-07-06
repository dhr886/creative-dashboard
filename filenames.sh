#!/bin/bash
#
# 文件名提取工具 - Shell 版
# 用法: ./filenames.sh [目录路径] [选项]
#
# 选项:
#   -r    递归扫描子目录
#   -e    只提取文件扩展名
#   -f    只提取不带扩展名的文件名
#   -s    按名称排序
#   -o    指定输出文件 (默认: filenames.txt)

TARGET_DIR="."
RECURSIVE=false
EXT_ONLY=false
NAME_ONLY=false
SORT_OUTPUT=false
OUTPUT_FILE="filenames.txt"

print_help() {
    echo "╔══════════════════════════════════════╗"
    echo "║     文件名提取工具 - Shell 版        ║"
    echo "╚══════════════════════════════════════╝"
    echo ""
    echo "用法: $0 [目录路径] [选项]"
    echo ""
    echo "选项:"
    echo "  -r          递归扫描子目录"
    echo "  -e          只提取文件扩展名"
    echo "  -f          只提取不带扩展名的文件名"
    echo "  -s          按名称排序"
    echo "  -o <文件>   指定输出文件 (默认: filenames.txt)"
    echo "  -h          显示帮助"
    echo ""
    echo "示例:"
    echo "  $0 ./src -r -s              递归扫描 src 目录并排序"
    echo "  $0 . -o list.txt            扫描当前目录，输出到 list.txt"
    echo "  $0 ~/Downloads -r -e -s     递归提取下载目录的扩展名"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -r) RECURSIVE=true; shift ;;
        -e) EXT_ONLY=true; shift ;;
        -f) NAME_ONLY=true; shift ;;
        -s) SORT_OUTPUT=true; shift ;;
        -o) OUTPUT_FILE="$2"; shift 2 ;;
        -h) print_help; exit 0 ;;
        -*) echo "未知选项: $1"; print_help; exit 1 ;;
        *)  TARGET_DIR="$1"; shift ;;
    esac
done

if [ ! -d "$TARGET_DIR" ]; then
    echo "❌ 目录不存在: $TARGET_DIR"
    exit 1
fi

if [ "$RECURSIVE" = true ]; then
    FILE_LIST=$(find "$TARGET_DIR" -type f)
else
    FILE_LIST=$(find "$TARGET_DIR" -maxdepth 1 -type f)
fi

RESULT=""
while IFS= read -r filepath; do
    filename=$(basename "$filepath")

    if [ "$EXT_ONLY" = true ]; then
        ext="${filename##*.}"
        [ "$ext" != "$filename" ] && entry=".$ext" || continue
    elif [ "$NAME_ONLY" = true ]; then
        entry="${filename%.*}"
    else
        entry="$filename"
    fi

    RESULT+="$entry"$'\n'
done <<< "$FILE_LIST"

RESULT=$(echo "$RESULT" | sed '/^$/d')

if [ "$SORT_OUTPUT" = true ]; then
    RESULT=$(echo "$RESULT" | sort -u)
fi

COUNT=$(echo "$RESULT" | wc -l | tr -d ' ')

echo "$RESULT" > "$OUTPUT_FILE"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         提取完成!                    ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "📂 扫描目录: $TARGET_DIR"
echo "📄 文件数量: $COUNT"
echo "💾 已保存到: $OUTPUT_FILE"
echo ""
echo "────────── 文件列表 ──────────"
echo "$RESULT"
echo "──────────────────────────────"
echo ""
echo "💡 提示:"
echo "   查看: cat $OUTPUT_FILE"
echo "   复制全部: cat $OUTPUT_FILE | pbcopy"
echo "   复制单个: echo \"文件名\" | pbcopy"
