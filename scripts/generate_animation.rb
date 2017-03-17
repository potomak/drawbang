#!/usr/bin/env ruby

require 'rubygems'
require 'RMagick'
include Magick

#frames = Image.read("http://s3.amazonaws.com/draw.heroku.com/#{ARGV[0]}.gif_64.gif")
frames = Image.read('./download.png')
tiny_frames = ImageList.new
frames.map { |f| tiny_frames << f.resize(16, 16, BoxFilter).crop(0, 0, 8, 8, true).scale(8, 8) }

fps = 5
tiny_frames.ticks_per_second = 1000
tiny_frames.delay = (1/fps.to_f)*1000
tiny_frames.write("#{ARGV[0]}.gif")
