require 'models/drawing/image'
require 'models/drawing/storage'
require 'RMagick'

class Drawing
  include Image
  include Magick
  
  if :production == settings.environment
    include Storage::Aws
  else
    include Storage::File
  end
  
  def initialize(drawing)
    @drawing = drawing
  end
  
  def save
    id           = @drawing.delete(:id)
    request_host = @drawing.delete(:request_host)
    image        = @drawing.delete(:image)
    format       = image['frames'] ? "GIF" : "PNG"
    
    # process image
    image_object = Drawing.process_image(image)
    # process thumbnail
    thumb_image_object = Drawing.process_thumbnail(image_object)
    
    # save image
    image_url = Drawing.save_file(id, request_host, image_object.to_blob {|i| i.format = format})
    # save thumbnail
    Drawing.save_file("#{id}_64.#{format.downcase}", request_host, thumb_image_object.to_blob {|i| i.format = format})
    
    @drawing.merge!(:url => image_url)
    
    REDIS.set(Drawing.key(id), @drawing.to_json)
    REDIS.lpush("drawings", id)
    
    @drawing
  end
  
  def self.find(id)
    value = REDIS.get(key(id))
    JSON.parse(value) unless value.nil?
  end
  
  def self.destroy(id)
    delete_file(id)
    
    REDIS.del(key(id))
    REDIS.lrem("drawings", 0, id)
  end
  
  def self.all(opts)
    page     = opts[:page] || 0
    per_page = opts[:per_page] || 10
    host     = opts[:host] || "localhost:4567"
    
    start_index = page*per_page
    end_index   = start_index + per_page-1
    
    REDIS.lrange("drawings", start_index, end_index).map do |id|
      JSON.parse(REDIS.get(key(id))).merge(:id => id, :share_url => "http://#{host}/drawings/#{id}")
    end
  end
  
  def self.key(id)
    "drawing:#{id}"
  end
end