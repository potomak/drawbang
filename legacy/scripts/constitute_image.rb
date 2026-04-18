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

["gif", "png", "jpg"].each do |format|
  File.open("constitute_test_to_blob.#{format}", "w") do |file|
    # see http://www.imagemagick.org/RMagick/doc/image3.html#to_blob
    file << image_big.to_blob do |image|
      image.format = format.upcase
    end
  end
end

pixels = []
(width*height).times do |i|
  pixels << QuantumRange
  pixels << 0
  pixels << QuantumRange
  pixels << QuantumRange # use 0 for transparent
end

frame1 = Image.constitute(width, height, "RGBA", pixels)

pixels = []
(width*height).times do |i|
  pixels << 0
  pixels << QuantumRange
  pixels << QuantumRange
  pixels << QuantumRange # use 0 for transparent
end

frame2 = Image.constitute(width, height, "RGBA", pixels)

pixels = []
(width*height).times do |i|
  pixels << QuantumRange
  pixels << QuantumRange
  pixels << 0
  pixels << QuantumRange # use 0 for transparent
end

frame3 = Image.constitute(width, height, "RGBA", pixels)

fps = 5
anim = ImageList.new
anim << frame1
anim << frame2
anim << frame3
anim.ticks_per_second = 1000
puts "fps: #{fps}"
puts "1/fps: #{1/fps}"
puts "1.0/fps: #{1.0/fps}"
puts "1/fps.to_f: #{1/fps.to_f}"
puts "(1/fps.to_f)*1000: #{(1/fps.to_f)*1000}"
anim.delay = (1/fps.to_f)*1000 # see http://www.imagemagick.org/RMagick/doc/ilist.html#delay_eq
anim.write("constitute_animated.gif")