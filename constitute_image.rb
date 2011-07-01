require 'rubygems'
require 'RMagick'
include Magick

width = 16
height = 16
pixels = []

(width*height).times do |i|
  pixels << i*256
  pixels << i*256
  pixels << i*256
  pixels << QuantumRange # use 0 for transparent
end

image = Image.constitute(width, height, "RGBA", pixels)
image.write("constitute_test.png")

image_big = image.resize(320, 320, BoxFilter)
image_big.write("constitute_test_big.png")
