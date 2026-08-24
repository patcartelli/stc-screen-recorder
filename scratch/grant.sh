#!/bin/bash
# Open the three TCC panes this spike needs.
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"; sleep 2
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"; sleep 2
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
echo "Enable 'STC Spike Capture' in: Screen Recording, Input Monitoring, Camera, Microphone."
