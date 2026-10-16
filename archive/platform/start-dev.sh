#!/bin/bash
cd /home/z/my-project
trap "" SIGHUP SIGTERM SIGINT
exec bun run dev > /home/z/my-project/dev.log 2>&1
