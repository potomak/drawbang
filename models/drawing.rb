# Drawing model.
#
# Attributes:
#
# * created_at
# * url, image url
# * user, user object
#
# User object attributes:
#
# * uid
# * first_name
# * image
#
# Lists:
#
# * drawings
# * drawings:user:#{user_id}, user's drawings

require 'RMagick'
require 'models/drawing/image'
require 'models/drawing/storage'

class Drawing
  include Image
  include Magick
  
  # use different storage strategy depending on environment
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
    REDIS.lpush(Drawing.list(@drawing[:user][:uid]), id)
    REDIS.lpush(Drawing.list, id)
    REDIS.lpush(Drawing.children_list(@drawing[:parent]), id) if @drawing[:parent]
    
    @drawing
  end
  
  # Find drawing by id.
  #
  # If +:shallow+ option is true children aren't loaded.
  def self.find(id, opts={})
    value = REDIS.get(key(id))
    unless value.nil?
      drawing = JSON.parse(value)
      drawing[:children] = all(:list => children_list(id)) unless opts[:shallow]
      drawing[:parent] = find(drawing['parent'], :shallow => true)
      drawing.merge(:id => id)
    end
  end
  
  # Destroy drawing.
  #
  # This method destroy also drawing
  #
  #  * from all drawings list
  #  * from user (author) drawings list
  #  * from parent's children list
  # 
  # and removes list of children.
  def self.destroy(id, user_id)
    drawing = find(id, :shallow => true)

    delete_file(id)
    
    REDIS.del(key(id))
    REDIS.lrem(Drawing.list(user_id), 0, id)
    REDIS.lrem(Drawing.list, 0, id)
    REDIS.lrem(Drawing.children_list(drawing['parent']), 0, id) if drawing && drawing['parent']
    REDIS.del(Drawing.children_list(id))
  end
  
  # Returns an array of drawing objects.
  #
  # Example:
  #
  # [{
  #   "created_at" => 1331999288,
  #   "share_url"  => "http://localhost/drawings/39827484a8e1eca9be06bcca8bbe1106f5e8d2aa.png",
  #   "url"        => "http://localhost:4567/images/drawings/39827484a8e1eca9be06bcca8bbe1106f5e8d2aa.png",
  #   "id"         => "39827484a8e1eca9be06bcca8bbe1106f5e8d2aa.png"
  #   "user" => {
  #     "first_name" => "Giovanni",
  #     "uid"        => "1207768639",
  #     "image"      => "http://graph.facebook.com/1207768639/picture?type=square"
  #   }
  # }]
  def self.all(opts)
    user_id  = opts[:user_id]  || nil
    list     = opts[:list]     || list(user_id)
    page     = opts[:page]     || 0
    per_page = opts[:per_page] || 10
    host     = opts[:host]     || "localhost:4567"
    
    start_index = page*per_page
    end_index   = start_index + per_page-1
    
    REDIS.lrange(list, start_index, end_index).map do |id|
      drawing = find(id, :shallow => true)
      drawing.merge(:id => id, :share_url => "http://#{host}/drawings/#{id}") if drawing
    end
  end
  
  # Returns a string representing drawing key by +id+.
  def self.key(id)
    "drawing:#{id}"
  end
  
  # Returns a string representing drawings list or user drawings list if
  # +user_id+ is not +nil+.
  def self.list(user_id=nil)
    user_id ? "drawings:user:#{user_id}" : "drawings"
  end

  # Returns a string representing drawings children list.
  def self.children_list(id)
    "drawings:children:#{id}"
  end
  
  def self.generate_token
    Digest::SHA1.hexdigest(rand(36**32).to_s(36))
  end

  def self.thumb_url(image_url, size=64)
    "#{image_url}_#{size}#{File.extname(image_url.to_s)}"
  end
end