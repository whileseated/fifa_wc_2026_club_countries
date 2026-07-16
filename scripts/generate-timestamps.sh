#!/bin/bash

# Generate per-file timestamps using current build time for Vercel deployment

mkdir -p includes

# Get current timestamp in "YYYYMMDD - HH:MM AM/PM" format (New York time)
current_timestamp=$(TZ='America/New_York' date +'%Y%m%d - %-I:%M %p EST')

# Create timestamp JSON with current time for all HTML files
echo "{" > includes/file-timestamps.json

for file in *.html; do
  if [ -f "$file" ]; then
    echo "  \"$file\": \"$current_timestamp\"," >> includes/file-timestamps.json
  fi
done

# Remove trailing comma and close JSON
sed -i.bak '$ s/,$//' includes/file-timestamps.json && rm includes/file-timestamps.json.bak
echo "}" >> includes/file-timestamps.json

echo "Generated timestamps:"
cat includes/file-timestamps.json
