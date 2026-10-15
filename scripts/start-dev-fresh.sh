#!/bin/bash
# Temporary validation server: runs TCMS against the FRESH database (tcms_fresh)
# that was created purely from prisma/database-setup.sql — simulates the user's
# Neon journey exactly.trap "" SIGHUP SIGTERM SIGINT
cd /home/z/my-project
trap "" SIGHUP SIGTERM SIGINT
export DATABASE_URL="postgresql://tcms:tcms@127.0.0.1:5499/tcms_fresh"
export DIRECT_URL="postgresql://tcms:tcms@127.0.0.1:5499/tcms_fresh"
export JWT_SECRET="test-secret-for-fresh-db-validation-0123456789"
exec /home/z/my-project/node_modules/.bin/next dev -p 3000 > /tmp/devtest.log 2>&1
