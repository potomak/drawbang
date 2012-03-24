# A user.
#
# Example user structure
#
# {
#   "user_info" => {
#     "name"       => "Giovanni Cappellotto",
#     "nickname"   => "gcappellotto",
#     "email"      => nil,
#     "image"      => "http://graph.facebook.com/1207768639/picture?type=square",
#     "first_name" => "Giovanni",
#     "last_name"  => "Cappellotto",
#     "urls" => {
#       "Website"  => nil,
#       "Facebook" => "http://www.facebook.com/gcappellotto"
#     }
#   },
#   "extra" => {
#     "user_hash" => {
#       "username"     => "gcappellotto",
#       "name"         => "Giovanni Cappellotto",
#       "locale"       => "en_US",
#       "verified"     => true,
#       "updated_time" => "2012-01-19T14:25:00+0000",
#       "timezone"     => 1,
#       "link"         => "http://www.facebook.com/gcappellotto",
#       "gender"       => "male",
#       "first_name"   => "Giovanni",
#       "id"           => "1207768639",
#       "last_name"    => "Cappellotto",
#       "location" => {
#         "name" => "Venice, Italy",
#         "id"   => "107933505906257"
#       },
#       "hometown" => {
#         "name" => "Venice, Italy",
#         "id"   => "107933505906257"
#       },
#     }
#   },
#   "credentials" => {
#     "token"         => "XXX",
#     "refresh_token" => ""
#   },
#   "uid"      => "1207768639",
#   "provider" => "facebook"
# }

class User
  def initialize(user)
    @user = user
  end
  
  # Save user record and return user hash.
  def save
    REDIS.set @user.delete(:key), @user.to_json
    @user # NOTE: SET can't fail (http://redis.io/commands/set)
  end
  
  # Find user by +id+.
  def self.find(id)
    find_by_key(key(id))
  end
  
  # Finds user by +key+.
  def self.find_by_key(key)
    user = REDIS.get(key)
    JSON.parse(user) unless user.nil?
  end
  
  # Update user at +key+.
  def self.update(key, hash)
    user = User.find_by_key(key)
    return nil unless user
    User.new(user.merge(:key => key).merge(hash)).save
  end
  
  # Returns user's key for +id+.
  def self.key(id)
    "user:#{id}"
  end
end