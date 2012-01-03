require 'RMagick'
include Magick

drawings = REDIS.lrange("drawings", 0, -1).map {|id| JSON.parse(REDIS.get("drawing:#{id}")).merge(:id => id)}

# development
# images = ImageList.new(*drawings.map {|d| File.join(DRAWINGS_PATH, d[:id])})

# production
images = ImageList.new(*drawings.map {|d| d['url']})

tiny_images = ImageList.new

images.each {|i| tiny_images << i.resize(16, 16, BoxFilter)}

index = 0
side = Math.sqrt(tiny_images.size).to_i
matrix = []

tiny_images.each_index {|i| matrix[i/side] = ImageList.new if 0 == i%side; matrix[i/side] << tiny_images[i]}

matrix2 = ImageList.new

matrix.each {|m| matrix2 << m.append(false)}

total = matrix2.append(true)

# development
# total.write("total_test.png")

# production
Drawing.init_aws
AWS::S3::S3Object.store("total_test.png", total.to_blob, S3_BUCKET, :access => :public_read)